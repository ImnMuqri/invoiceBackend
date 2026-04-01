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
      const sixtyDaysAgo = new Date();
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

      // --- Aggregate Stats & Growth ---
      const [
        totalUsers,
        totalInvoices,
        totalActiveSubs,
        prevUsersCount,
        prevInvoicesCount,
      ] = await Promise.all([
        prisma.user.count(),
        prisma.invoice.count(),
        prisma.user.count({ where: { NOT: { plan: "FREE" } } }),
        prisma.user.count({
          where: { createdAt: { lt: thirtyDaysAgo, gte: sixtyDaysAgo } },
        }),
        prisma.invoice.count({
          where: { date: { lt: thirtyDaysAgo, gte: sixtyDaysAgo } },
        }),
      ]);

      // --- Web Analytics: Growth & Trends ---

      // User Growth (Daily)
      const usersLast30Days = await prisma.user.findMany({
        where: { createdAt: { gte: thirtyDaysAgo } },
        select: { createdAt: true },
      });

      const userGrowth = {};
      usersLast30Days.forEach((u) => {
        const date = u.createdAt.toISOString().split("T")[0];
        userGrowth[date] = (userGrowth[date] || 0) + 1;
      });

      // Revenue Trends (Daily)
      const targetCurrency = "USD";

      // 1. Paid Invoices
      const paidInvoices = await prisma.invoice.findMany({
        where: {
          status: "Paid",
          date: { gte: thirtyDaysAgo },
        },
        select: { amount: true, currency: true, date: true },
      });

      // 2. Active Subscriptions
      const activeSubscriptions = await prisma.subscription.findMany({
        where: {
          status: "ACTIVE",
          createdAt: { gte: thirtyDaysAgo },
        },
        select: { amount: true, currency: true, createdAt: true },
      });

      const revenueTrends = {};

      // Process Invoices
      paidInvoices.forEach((inv) => {
        const date = inv.date.toISOString().split("T")[0];
        const converted = convertAmount(
          inv.amount,
          inv.currency,
          targetCurrency,
        );
        revenueTrends[date] = (revenueTrends[date] || 0) + converted;
      });

      // Process Subscriptions
      activeSubscriptions.forEach((sub) => {
        const date = sub.createdAt.toISOString().split("T")[0];
        const converted = convertAmount(
          sub.amount,
          sub.currency,
          targetCurrency,
        );
        revenueTrends[date] = (revenueTrends[date] || 0) + converted;
      });

      // Calculate Revenue Growth (Comparing current 30d vs previous 30d)
      const prevPaidInvoices = await prisma.invoice.findMany({
        where: {
          status: "Paid",
          date: { lt: thirtyDaysAgo, gte: sixtyDaysAgo },
        },
        select: { amount: true, currency: true },
      });

      const prevActiveSubs = await prisma.subscription.findMany({
        where: {
          status: "ACTIVE",
          createdAt: { lt: thirtyDaysAgo, gte: sixtyDaysAgo },
        },
        select: { amount: true, currency: true },
      });

      const prevRevenue =
        prevPaidInvoices.reduce(
          (sum, inv) =>
            sum + convertAmount(inv.amount, inv.currency, targetCurrency),
          0,
        ) +
        prevActiveSubs.reduce(
          (sum, sub) =>
            sum + convertAmount(sub.amount, sub.currency, targetCurrency),
          0,
        );

      const totalCurrentRevenue = Object.values(revenueTrends).reduce(
        (sum, val) => sum + val,
        0,
      );

      // Lifetime Totals
      const lifetimeInvoices = await prisma.invoice.aggregate({
        where: { status: "Paid" },
        _sum: { amount: true },
      });

      const lifetimeSubs = await prisma.subscription.aggregate({
        where: { status: "ACTIVE" },
        _sum: { amount: true },
      });

      const totalLifetimeRevenue =
        (lifetimeInvoices._sum.amount || 0) + (lifetimeSubs._sum.amount || 0);

      const calcGrowth = (curr, prev) => {
        if (prev === 0) return curr > 0 ? 100 : 0;
        return parseFloat((((curr - prev) / prev) * 100).toFixed(1));
      };

      // Plan Distribution
      const planStats = await prisma.user.groupBy({
        by: ["plan"],
        _count: { id: true },
      });

      // Security Analytics
      const securityStats = await prisma.user.groupBy({
        by: ["isActive", "role"],
        _count: { id: true },
      });

      // System Health
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const systemHealth = {
        uptime: os.uptime(),
        memory: {
          total: (totalMem / (1024 * 1024 * 1024)).toFixed(2) + " GB",
          used: (usedMem / (1024 * 1024 * 1024)).toFixed(2) + " GB",
          free: (freeMem / (1024 * 1024 * 1024)).toFixed(2) + " GB",
          percentUsed: ((usedMem / totalMem) * 100).toFixed(2) + "%",
        },
        nodeVersion: process.version,
        platform: os.platform(),
        cpus: os.cpus().length,
        dbStatus: "Healthy",
      };

      return {
        summary: {
          revenue: {
            total: parseFloat(totalCurrentRevenue.toFixed(2)),
            lifetime: totalLifetimeRevenue,
            growth: calcGrowth(totalCurrentRevenue, prevRevenue),
          },
          users: {
            total: totalUsers,
            growth: calcGrowth(usersLast30Days.length, prevUsersCount),
          },
          invoices: {
            total: totalInvoices,
            growth: calcGrowth(paidInvoices.length, prevInvoicesCount),
          },
          totalTransactions: paidInvoices.length + activeSubscriptions.length,
          activeSubscriptions: totalActiveSubs,
        },
        web: {
          userGrowth: Object.entries(userGrowth)
            .map(([date, count]) => ({ date, count }))
            .sort((a, b) => a.date.localeCompare(b.date)),
          revenueTrends: Object.entries(revenueTrends)
            .map(([date, amount]) => ({
              date,
              amount: parseFloat(amount.toFixed(2)),
            }))
            .sort((a, b) => a.date.localeCompare(b.date)),
          planDistribution: planStats.map((ps) => ({
            plan: ps.plan,
            count: ps._count.id,
          })),
          currency: targetCurrency,
        },
        security: {
          distribution: securityStats.map((ss) => ({
            role: ss.role,
            isActive: ss.isActive,
            count: ss._count.id,
          })),
        },
        system: systemHealth,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to fetch analytics data");
    }
  });

  // GET /monthly - Calculate revenue for a specific month/year
  fastify.get("/monthly", async (request, reply) => {
    try {
      const { month, year } = request.query;
      if (!month || !year) {
        return reply.badRequest("Month and Year are required");
      }

      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0, 23, 59, 59);

      const targetCurrency = "USD";
      const [paidInvoices, activeSubs] = await Promise.all([
        prisma.invoice.findMany({
          where: {
            status: "Paid",
            date: { gte: startDate, lte: endDate },
          },
          select: { amount: true, currency: true },
        }),
        prisma.subscription.findMany({
          where: {
            status: "ACTIVE",
            createdAt: { gte: startDate, lte: endDate },
          },
          select: { amount: true, currency: true },
        }),
      ]);

      const invRevenue = paidInvoices.reduce(
        (sum, inv) =>
          sum + convertAmount(inv.amount, inv.currency, targetCurrency),
        0,
      );

      const subRevenue = activeSubs.reduce(
        (sum, sub) =>
          sum + convertAmount(sub.amount, sub.currency, targetCurrency),
        0,
      );

      const totalMonthlyRevenue = invRevenue + subRevenue;

      return {
        month: parseInt(month),
        year: parseInt(year),
        revenue: parseFloat(totalMonthlyRevenue.toFixed(2)),
        currency: targetCurrency,
        transactionCount: paidInvoices.length + activeSubs.length,
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to fetch monthly revenue");
    }
  });
}

module.exports = analyticsRoutes;
