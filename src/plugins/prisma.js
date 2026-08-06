const fp = require("fastify-plugin");
const { PrismaClient } = require("@prisma/client");
const { TtlCache } = require("../utils/ttlCache");

async function prismaPlugin(fastify, opts) {
  const prisma = new PrismaClient();

  await prisma.$connect();

  fastify.decorate("prisma", prisma);

  /* Two tables that are read on nearly every page and written a few times a
     year: the single SystemConfiguration row, and the Plan list. Both were
     fetched fresh per request. 60s is long enough to remove them from the hot
     path and short enough that an admin toggling the kill switch sees it take
     effect while they are still looking at the page.

     Both writers invalidate explicitly — see the admin system and plan routes —
     so the TTL is only a backstop. */
  const refCache = new TtlCache({ ttlMs: 60_000, max: 16 });
  fastify.decorate("refCache", refCache);

  fastify.decorate("getSystemConfig", async () => {
    return refCache.wrap("systemConfig", async () => {
      let cfg = await prisma.systemConfiguration.findFirst();
      if (!cfg) {
        cfg = await prisma.systemConfiguration.create({
          data: {
            whatsappEnabled: true,
            emailEnabled: true,
            invoiceCreationEnabled: true,
            paymentsEnabled: true,
            globalNotice: null,
            maintenanceMode: false,
          },
        });
      }
      return cfg;
    });
  });

  fastify.decorate("getPlans", async () =>
    refCache.wrap("plans", () => prisma.plan.findMany()),
  );

  fastify.addHook("onClose", async (fastify) => {
    await fastify.prisma.$disconnect();
  });
}

module.exports = fp(prismaPlugin);
