const fastify = require("fastify")({
  /* One line per request and one per response, at info, was the default. In
     production that is two synchronous-ish stdout writes on every API call for
     information the platform already records. Errors and warnings still get
     through, and NODE_ENV=development keeps the full stream. */
  logger:
    process.env.NODE_ENV === "production"
      ? { level: process.env.LOG_LEVEL || "warn" }
      : true,
  ajv: {
    plugins: [require("ajv-formats")],
  },
});
const path = require("path");
const autoload = require("@fastify/autoload");
require("dotenv").config({ path: path.join(__dirname, ".env") });

function validateEnv() {
  const required = [
    "DATABASE_URL",
    "JWT_SECRET",
    "FRONTEND_URL",
    "GROQ_API_KEY",
    "ENCRYPTION_KEY",
  ];
  /* Warned about, not required.
     Adding XENDIT_CALLBACK_TOKEN to `required` would refuse to boot without it,
     which on the next deploy would take a running production down over a
     variable that has been absent for months. But it is not optional either:
     the payment webhook now fails closed, so with this unset every genuine
     subscription payment is rejected and nobody is ever upgraded — silently,
     because the only symptom is a customer who paid and did not get their plan.

     Loud once at startup is the right volume for that. */
  if (!process.env.XENDIT_CALLBACK_TOKEN) {
    console.warn(
      "⚠️  XENDIT_CALLBACK_TOKEN is not set. Subscription payment webhooks will be " +
        "REJECTED, so paid upgrades will not apply. Set it from the Xendit dashboard.",
    );
  }

  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`❌ FATAL: Missing environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
}

async function build() {
  // Register Sensible
  await fastify.register(require("@fastify/sensible"));

  // Register Multipart
  await fastify.register(require("@fastify/multipart"), {
    limits: {
      fieldNameSize: 100, // Max field name size in bytes
      fieldSize: 100, // Max field value size in bytes
      fields: 10, // Max number of non-file fields
      fileSize: 5000000, // For multipart forms, the max file size in bytes
      files: 1, // Max number of file fields
      headerPairs: 2000, // Max number of header key=>value pairs
    },
  });

  // Register Static for uploads
  const fs = require("fs");
  const uploadDir = path.join(__dirname, "public/uploads");
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  await fastify.register(require("@fastify/static"), {
    root: path.join(__dirname, "public"),
    prefix: "/public/", // optional: default '/'
  });

  // Register CORS
  await fastify.register(require("@fastify/cors"), {
    origin: [
      "https://invokita.my",
      "http://localhost:3000",
      "https://invokita.pages.dev",
    ],
    methods: ["GET", "PUT", "POST", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
    ],
    credentials: true,
    maxAge: 86400,
  });

  // Register Helmet
  /* Gzip/brotli on responses. The dashboard payload is the obvious case — it is
     JSON with a lot of repeated keys, which is what deflate is good at.
     threshold skips small bodies, where the CPU cost is not repaid. */
  await fastify.register(require("@fastify/compress"), {
    global: true,
    threshold: 1024,
    encodings: ["br", "gzip", "deflate"],
  });

  await fastify.register(require("@fastify/helmet"), {
    contentSecurityPolicy: false,
    hsts: true,
  });

  // Register Rate Limit
  await fastify.register(require("@fastify/rate-limit"), {
    max: 1000,
    timeWindow: "1 minute",
  });

  // Register JWT
  await fastify.register(require("@fastify/jwt"), {
    secret: process.env.JWT_SECRET || "default-secret-key",
  });

  // Register Prisma plugin
  await fastify.register(require("./src/plugins/prisma"));

  // Hooks & Decorators
  /* The account check behind every authenticated request.
     This was a database round trip per API call — the single most frequent
     query in the product, run before any route did its own work. It reads two
     rarely-changing columns, so it is cached for 30 seconds per user.

     The cost of caching is that disabling an account or changing a role takes
     up to 30s to bite. That is why authCache.delete(userId) is called wherever
     those columns are written (see the admin user routes); the TTL is the
     backstop, not the mechanism. */
  const { TtlCache } = require("./src/utils/ttlCache");
  const authCache = new TtlCache({ ttlMs: 30_000, max: 10_000 });
  fastify.decorate("authCache", authCache);

  fastify.decorate("authenticate", async (request, reply) => {
    try {
      if (request.method === "OPTIONS") return;
      const decoded = await request.jwtVerify();
      const user = await authCache.wrap(decoded.id, () =>
        fastify.prisma.user.findUnique({
          where: { id: decoded.id },
          select: { isActive: true, role: true },
        }),
      );
      if (!user || !user.isActive)
        return reply.unauthorized("Account disabled");
      request.user.role = user.role;
    } catch (err) {
      reply.unauthorized();
    }
  });

  fastify.decorate("isAdmin", async (request, reply) => {
    if (request.method === "OPTIONS") return;
    if (!request.user || request.user.role !== "ADMIN") {
      return reply.forbidden("Admin access required");
    }
  });

  // Register other plugins
  await fastify.register(require("./src/plugins/puppeteer"));
  await fastify.register(require("./src/plugins/email"));
  await fastify.register(require("./src/plugins/whatsapp"));
  await fastify.register(require("./src/plugins/usage"));
  /* After usage: chase metering reads limitsFor() from it. */
  await fastify.register(require("./src/plugins/chase"));
  /* After chase: recurring delivery degrades through it. */
  await fastify.register(require("./src/plugins/recurring"));
  /* Background jobs — the 09:00 reminder sweep and the 01:00 overdue pass.
     Gated on ROLE so this file can serve both a web service and a worker.

     Today there is one Railway service and ROLE is unset, so this registers and
     nothing changes. The point is what it costs to split later: when background
     work starts stealing time from requests, splitting becomes "add a service,
     set ROLE=worker on it and ROLE=web here" rather than a refactor done under
     pressure. Set ROLE=web now and the cron stops running in this process.

     It is also the guard against the mistake that split would otherwise invite:
     two services from one repo both running the scheduler, so every reminder
     goes out twice. */
  if (process.env.ROLE !== "web") {
    await fastify.register(require("./src/plugins/cron"));
    fastify.log.info({ role: process.env.ROLE || "(unset)" }, "Scheduled jobs registered in this process");
  } else {
    fastify.log.info("ROLE=web — scheduled jobs are not registered in this process");
  }

  // Parse application/x-www-form-urlencoded natively for Payment Webhooks (like ToyyibPay)
  fastify.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    function (req, body, done) {
      req.rawBody = body; // Attach raw body
      try {
        const parsed = Object.fromEntries(new URLSearchParams(body));
        done(null, parsed);
      } catch (err) {
        done(err, undefined);
      }
    },
  );

  // Parse application/json and keep raw body for signature verification (HitPay)
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    function (req, body, done) {
      req.rawBody = body; // Attach raw body
      try {
        const json = JSON.parse(body);
        done(null, json);
      } catch (err) {
        err.statusCode = 400;
        done(err, undefined);
      }
    },
  );

  // Autoload routes
  await fastify.register(autoload, {
    dir: path.join(__dirname, "src/routes"),
    options: { prefix: "/api" },
  });

  return fastify;
}

const start = async () => {
  try {
    validateEnv();
    const app = await build();
    const port = process.env.PORT || 3002;
    await app.listen({ port, host: "0.0.0.0" });

    // Graceful Shutdown
    const signals = ["SIGTERM", "SIGINT"];
    signals.forEach((signal) => {
      process.on(signal, async () => {
        app.log.info(`Received ${signal}, closing server...`);
        await app.close();
        app.log.info("Server closed gradiently.");
        process.exit(0);
      });
    });
  } catch (err) {
    if (fastify.log) fastify.log.error(err);
    else console.error(err);
    process.exit(1);
  }
};

start();
