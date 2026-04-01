async function dashboardRoutes(fastify, opts) {
  const { prisma } = fastify;
  const { convertAmount } = require("../../utils/currency");

  // Apply authentication to all routes in this plugin
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/core", async (request, reply) => {
    try {
      const now = new Date();

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
        .filter((inv) => ["Pending", "Overdue"].includes(inv.status))
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

      const { rank = "top5" } = request.query;

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
            amount: rank === "bottom5" ? "asc" : "desc",
          },
        },
        take: plan === "FREE" ? 1 : 5,
      });

      const topClients = await Promise.all(
        topClientsRaw.map(async (raw) => {
          const client = await prisma.client.findUnique({
            where: { id: raw.clientId },
          });

          const clientPaidInvoices = await prisma.invoice.findMany({
            where: { clientId: raw.clientId, status: "Paid" },
          });

          const convertedRevenue = clientPaidInvoices.reduce((sum, inv) => {
            return (
              sum + convertAmount(inv.amount, inv.currency, targetCurrency)
            );
          }, 0);

          return {
            id: client?.id || raw.clientId,
            name: client?.name || "Deleted Client",
            totalRevenue: convertedRevenue,
            profitMargin: client?.profitMargin || 25,
            averageDelayDays: client?.averageDelayDays || 0,
            status: client?.status || "Active",
          };
        }),
      );

      // AI Insights logic (Generative AI with 2-day cooldown)
      let insights = [];
      if (plan !== "FREE") {
        const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
        let cachedInsights = [];
        try {
          cachedInsights = user.aiInsights ? JSON.parse(user.aiInsights) : [];
        } catch (e) {
          cachedInsights = [];
        }

        // Regenerate if no insights or 2 days have passed
        if (
          !user.lastAiInsightAt ||
          new Date(user.lastAiInsightAt) < twoDaysAgo
        ) {
          const { generateInsights } = require("../../utils/aiService");

          // Usage check (AI insights consume 1 credit)
          try {
            await fastify.usage.checkAndIncrement(user.id, "ai");
          } catch (err) {
            // If credit limit reached, just use cached
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
              usageLimits: PLAN_LIMITS[plan] || PLAN_LIMITS.FREE,
              insights: cachedInsights,
            };
          }

          // Fetch fresh overdue context for AI
          const overdueInvoicesContext = await prisma.invoice.findMany({
            where: { userId: user.id, status: "Overdue" },
            select: {
              amount: true,
              currency: true,
              dueDate: true,
              client: { select: { name: true } },
            },
            take: 5,
          });

          const aiContext = {
            currency: targetCurrency,
            totalRevenue,
            outstandingAmount,
            overdueInvoices: overdueInvoicesContext,
            topClients,
          };

          const newInsights = await generateInsights(aiContext);

          if (newInsights && newInsights.length > 0) {
            // Persist insights and update cooldown
            await prisma.user.update({
              where: { id: user.id },
              data: {
                aiInsights: JSON.stringify(newInsights),
                lastAiInsightAt: new Date(),
              },
            });
            insights = newInsights;
          } else {
            insights = cachedInsights;
          }
        } else {
          insights = cachedInsights;
        }
      }

      // Usage Limits Helper
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
        usageLimits: PLAN_LIMITS[plan] || PLAN_LIMITS.FREE,
        insights,
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to fetch core dashboard data");
    }
  });

  fastify.get("/forecast", async (request, reply) => {
    try {
      const { range, month, year } = request.query;
      const now = new Date();

      let historyStartDate, forecastEndDate;

      if (month && year) {
        const m = parseInt(month);
        const y = parseInt(year);
        historyStartDate = new Date(y, m - 1, 1);
        forecastEndDate = new Date(y, m, 0, 23, 59, 59);
      } else if (range === "all") {
        historyStartDate = new Date(2000, 0, 1);
        forecastEndDate = new Date(2100, 0, 1);
      } else {
        const r = parseInt(range) || 30;
        historyStartDate = new Date();
        historyStartDate.setDate(now.getDate() - r);
        forecastEndDate = new Date();
        forecastEndDate.setDate(now.getDate() + r);
      }

      const user = await prisma.user.findUnique({
        where: { id: request.user.id },
      });
      const targetCurrency = user.defaultCurrency || "MYR";

      const paidInvoices = await prisma.invoice.findMany({
        where: {
          userId: request.user.id,
          status: "Paid",
          date: { gte: historyStartDate, lte: now },
        },
        include: { client: true },
      });

      const pendingInvoices = await prisma.invoice.findMany({
        where: {
          userId: request.user.id,
          status: { in: ["Pending", "Overdue"] },
          dueDate: { gte: now, lte: forecastEndDate },
        },
        include: { client: true },
      });

      const groupData = (data, dateKey) => {
        const groups = {};

        // Process actual data
        for (const item of data) {
          const date = new Date(item[dateKey]);
          const key = date.toISOString().split("T")[0];

          if (!groups[key]) {
            groups[key] = { amount: 0, details: [] };
          }

          const converted = convertAmount(
            item.amount,
            item.currency,
            targetCurrency,
          );
          groups[key].amount = (groups[key].amount || 0) + converted;

          groups[key].details.push({
            clientName: item.client?.name || "N/A",
            clientId: item.clientId || "Unknown",
            invoiceNumber: item.invoiceNumber || item.id,
            amount: parseFloat(converted.toFixed(2)),
            dueDate: item.dueDate || item.date,
          });
        }

        // Finalize and return as sorted array
        return Object.keys(groups)
          .sort()
          .map((date) => {
            const group = groups[date];
            return {
              date,
              amount: parseFloat((group.amount || 0).toFixed(2)),
              details: group.details.length > 0 ? group.details : [],
            };
          });
      };

      return {
        cashflow: {
          history: groupData(paidInvoices, "date"),
          forecast: groupData(pendingInvoices, "dueDate"),
        },
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to fetch forecast data");
    }
  });
}

module.exports = dashboardRoutes;
