const fastify = require("fastify")({
  logger: true,
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
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`❌ FATAL: Missing environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
}

async function build() {
  // Register Sensible
  await fastify.register(require("@fastify/sensible"));

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
  fastify.decorate("authenticate", async (request, reply) => {
    try {
      if (request.method === "OPTIONS") return;
      const decoded = await request.jwtVerify();
      const user = await fastify.prisma.user.findUnique({
        where: { id: decoded.id },
        select: { isActive: true, role: true },
      });
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
  await fastify.register(require("./src/plugins/cron"));

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
