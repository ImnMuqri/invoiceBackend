async function dashboardRoutes(fastify, opts) {
  const { prisma } = fastify;
  const { convertAmount } = require("../../utils/currency");

  // Apply authentication to all routes in this plugin
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request, reply) => {
    try {
      const range = parseInt(request.query.range) || 30;
      const now = new Date();
      const rangeDate = new Date();
      rangeDate.setDate(now.getDate() + range);

      // Get user's default currency and plan
      const user = await prisma.user.findUnique({
        where: { id: request.user.id },
      });
      const targetCurrency = user.defaultCurrency || "MYR";
      const plan = user.plan || "FREE";

      // Fetch all relevant invoices for manual summation with conversion
      const allInvoices = await prisma.invoice.findMany({
        where: { userId: request.user.id },
      });

      const totalRevenue = allInvoices
        .filter((inv) => inv.status === "Paid")
        .reduce((sum, inv) => {
          return sum + convertAmount(inv.amount, inv.currency, targetCurrency);
        }, 0);

      const outstandingAmount = allInvoices
        .filter((inv) => inv.status === "Pending")
        .reduce((sum, inv) => {
          return sum + convertAmount(inv.amount, inv.currency, targetCurrency);
        }, 0);

      const overdueCount = await prisma.invoice.count({
        where: {
          userId: request.user.id,
          OR: [
            { status: "Overdue" },
            {
              status: "Pending",
              dueDate: { lt: now },
            },
          ],
        },
      });

      const activeClientsCount = await prisma.client.count({
        where: { userId: request.user.id },
      });

      const recentInvoices = await prisma.invoice.findMany({
        where: { userId: request.user.id },
        take: 5,
        orderBy: { date: "desc" },
        include: { client: true },
      });

      const topClientsRaw = await prisma.invoice.groupBy({
        by: ["clientId"],
        where: {
          userId: request.user.id,
          status: "Paid",
        },
        _sum: {
          amount: true,
        },
        orderBy: {
          _sum: {
            amount: "desc",
          },
        },
        take: plan === "FREE" ? 1 : 5,
      });

      const topClients = await Promise.all(
        topClientsRaw.map(async (raw) => {
          const client = await prisma.client.findUnique({
            where: { id: raw.clientId },
          });
          
          // For top clients, we need to convert each paid invoice individually for accuracy
          // since grouping by amount doesn't account for currency
          const clientPaidInvoices = await prisma.invoice.findMany({
            where: { clientId: raw.clientId, status: "Paid" }
          });
          
          const convertedRevenue = clientPaidInvoices.reduce((sum, inv) => {
            return sum + convertAmount(inv.amount, inv.currency, targetCurrency);
          }, 0);

          return {
            id: client?.id || raw.clientId,
            name: client?.name || "Deleted Client",
            totalRevenue: convertedRevenue,
            profitMargin: client?.profitMargin || 25,
          };
        }),
      );

      // Cashflow History - matching period in the past
      const historyStartDate = new Date();
      historyStartDate.setDate(now.getDate() - range);

      const paidInvoices = await prisma.invoice.findMany({
        where: {
          userId: request.user.id,
          status: "Paid",
          date: { gte: historyStartDate, lte: now },
        },
        select: {
          date: true,
          amount: true,
          currency: true,
        },
      });

      // Forecast - invoices due within the range
      const pendingInvoices = await prisma.invoice.findMany({
        where: {
          userId: request.user.id,
          status: { in: ["Pending", "Overdue"] },
          dueDate: { gte: now, lte: rangeDate },
        },
        select: {
          dueDate: true,
          amount: true,
          currency: true,
        },
      });

      // Grouping helper
      const groupData = (data, dateKey) => {
        const groups = {};
        data.forEach((item) => {
          const date = new Date(item[dateKey]);
          const key = date.toISOString().split("T")[0];
          const converted = convertAmount(item.amount, item.currency, targetCurrency);
          groups[key] = (groups[key] || 0) + converted;
        });
        return Object.keys(groups)
          .sort()
          .map((date) => ({ date, amount: parseFloat(groups[date].toFixed(2)) }));
      };

      const historyRecords = groupData(paidInvoices, "date");
      const forecastRecords = groupData(pendingInvoices, "dueDate");

      // Plan Limits
      const PLAN_LIMITS = {
        FREE: {
          waSends: 0,
          emailSends: 5,
          aiCredits: 0,
          waReminders: 0,
          emailReminders: 0,
          invoices: 5,
        },
        PRO: {
          waSends: 50,
          emailSends: 100,
          aiCredits: 20,
          waReminders: 50,
          emailReminders: 50,
          invoices: 30,
        },
        MAX: {
          waSends: 100,
          emailSends: 100,
          aiCredits: 100,
          waReminders: 100,
          emailReminders: 100,
          invoices: 100,
        },
      };

      const usageLimits = PLAN_LIMITS[plan] || PLAN_LIMITS.FREE;

      // AI Insights logic
      let insights = [];
      if (plan !== "FREE") {
        const overdueInvoices = await prisma.invoice.findMany({
          where: {
            status: "Pending",
            dueDate: { lt: now },
            userId: request.user.id,
          },
          include: { client: true },
          take: 3,
        });

        overdueInvoices.forEach((inv) => {
          insights.push({
            type: "chaser",
            id: inv.id,
            title: `Overdue: ${inv.client.name}`,
            description: `Invoice ${inv.invoiceNumber || inv.id} is overdue by ${Math.floor((now - new Date(inv.dueDate)) / (1000 * 60 * 60 * 24))} days.`,
            action: "Send Chaser",
          });
        });

        if (insights.length === 0) {
          insights.push({
            type: "info",
            title: "All caught up!",
            description: "No urgent chasers needed right now. Good job!",
            action: "View All",
          });
        }
      }

      return {
        stats: {
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          outstandingAmount: parseFloat(outstandingAmount.toFixed(2)),
          overdueCount,
          activeClients: activeClientsCount,
          currency: targetCurrency,
        },
        recentInvoices,
        topClients,
        cashflow: {
          history: historyRecords,
          forecast: forecastRecords,
        },
        usageLimits,
        insights,
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to fetch dashboard data");
    }
  });
}

module.exports = dashboardRoutes;
