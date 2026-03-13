const fastify = require("fastify")({ logger: true });
const path = require("path");
const autoload = require("@fastify/autoload");
require("dotenv").config({ path: path.join(__dirname, ".env") });

async function build() {
  // Register Sensible for better error handling
  await fastify.register(require("@fastify/sensible"));

  // Register JWT
  await fastify.register(require("@fastify/jwt"), {
    secret: process.env.JWT_SECRET || "default-secret-key",
  });

  // Authentication hook
  fastify.decorate("authenticate", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch (err) {
      reply.unauthorized();
    }
  });

  // Register CORS
  await fastify.register(require("@fastify/cors"), {
    origin: true, // In production, specify your frontend origin
  });

  // Register Prisma plugin
  await fastify.register(require("./src/plugins/prisma"));

  // Register Puppeteer plugin
  await fastify.register(require("./src/plugins/puppeteer"));

  // Register Email plugin (Resend)
  await fastify.register(require("./src/plugins/email"));

  // Register WhatsApp plugin
  await fastify.register(require("./src/plugins/whatsapp"));

  // Register Usage plugin
  await fastify.register(require("./src/plugins/usage"));

  // Register Cron plugin
  await fastify.register(require("./src/plugins/cron"));

  // Autoload routes
  await fastify.register(autoload, {
    dir: path.join(__dirname, "src/routes"),
    options: { prefix: "/api" },
  });

  return fastify;
}

const start = async () => {
  try {
    const app = await build();
    const port = process.env.PORT || 3002;
    await app.listen({ port, host: "0.0.0.0" });
    console.log(`Server listening on http://localhost:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
