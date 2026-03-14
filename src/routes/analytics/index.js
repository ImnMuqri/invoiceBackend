const os = require("os");

async function analyticsRoutes(fastify, opts) {
  const { prisma } = fastify;
  const { convertAmount } = require("../../utils/currency");

  // Apply authentication and admin check
  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("onRequest", fastify.isAdmin);

  fastify.get("/", async (request, reply) => {
    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      // --- Web Analytics: Growth & Trends ---
      
      // User Growth (Daily)
      const usersLast30Days = await prisma.user.findMany({
        where: { createdAt: { gte: thirtyDaysAgo } },
        select: { createdAt: true },
      });

      const userGrowth = {};
      usersLast30Days.forEach(u => {
        const date = u.createdAt.toISOString().split("T")[0];
        userGrowth[date] = (userGrowth[date] || 0) + 1;
      });

      // Revenue Trends (Daily - Converting to USD base for global view or default MYR)
      // For simplicity, we use the user's default logic or a fixed target like 'USD'
      const targetCurrency = "USD"; 
      const paidInvoices = await prisma.invoice.findMany({
        where: {
          status: "Paid",
          date: { gte: thirtyDaysAgo }
        },
        select: { amount: true, currency: true, date: true }
      });

      const revenueTrends = {};
      paidInvoices.forEach(inv => {
        const date = inv.date.toISOString().split("T")[0];
        const converted = convertAmount(inv.amount, inv.currency, targetCurrency);
        revenueTrends[date] = (revenueTrends[date] || 0) + converted;
      });

      // Plan Distribution
      const planStats = await prisma.user.groupBy({
        by: ["plan"],
        _count: { id: true }
      });

      // --- Security Analytics ---
      const securityStats = await prisma.user.groupBy({
        by: ["isActive", "role"],
        _count: { id: true }
      });

      // --- System Health ---
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      
      const systemHealth = {
        uptime: os.uptime(),
        memory: {
          total: (totalMem / (1024 * 1024 * 1024)).toFixed(2) + " GB",
          used: (usedMem / (1024 * 1024 * 1024)).toFixed(2) + " GB",
          free: (freeMem / (1024 * 1024 * 1024)).toFixed(2) + " GB",
          percentUsed: ((usedMem / totalMem) * 100).toFixed(2) + "%"
        },
        nodeVersion: process.version,
        platform: os.platform(),
        cpus: os.cpus().length,
        dbStatus: "Healthy" // Basic check since the query succeeded
      };

      return {
        web: {
          userGrowth: Object.entries(userGrowth).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)),
          revenueTrends: Object.entries(revenueTrends).map(([date, amount]) => ({ date, amount: parseFloat(amount.toFixed(2)) })).sort((a, b) => a.date.localeCompare(b.date)),
          planDistribution: planStats.map(ps => ({ plan: ps.plan, count: ps._count.id })),
          currency: targetCurrency
        },
        security: {
          distribution: securityStats.map(ss => ({
            role: ss.role,
            isActive: ss.isActive,
            count: ss._count.id
          }))
        },
        system: systemHealth,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to fetch analytics data");
    }
  });
}

module.exports = analyticsRoutes;
