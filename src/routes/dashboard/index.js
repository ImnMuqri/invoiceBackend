async function dashboardRoutes(fastify, opts) {
  const { prisma } = fastify;
  const { convertAmount } = require("../../utils/currency");

  // Apply authentication to all routes in this plugin
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/core", async (request, reply) => {
    try {
      const now = new Date();

      // Get user's default currency and plan from sub-models
      const user = await prisma.user.findUnique({
        where: { id: request.user.id },
        select: {
          plan: true,
          profile: { select: { defaultCurrency: true } },
          notification: { select: { aiInsights: true, lastAiInsightAt: true } },
        },
      });
      const targetCurrency = user.profile?.defaultCurrency || "MYR";
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

      // Fetch overdue invoices for AI context
      const overdueInvoicesContext = await prisma.invoice.findMany({
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
        include: { client: true },
        take: 5,
      });

      // AI Insights logic (Generative AI with 2-day cooldown)
      let insights = [];
      if (plan !== "FREE") {
        const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
        const notif = user.notification || {};
        let cachedInsights = [];
        try {
          cachedInsights = notif.aiInsights ? JSON.parse(notif.aiInsights) : [];
        } catch (e) {
          cachedInsights = [];
        }

        // Regenerate if no insights or 2 days have passed
        if (
          !notif.lastAiInsightAt ||
          new Date(notif.lastAiInsightAt) < twoDaysAgo
        ) {
          const { generateInsights } = require("../../utils/aiService");

          // AI insights no longer consume credits, just cooldown-managed
          const aiContext = {
            currency: targetCurrency,
            totalRevenue,
            outstandingAmount,
            overdueInvoices: overdueInvoicesContext,
            topClients,
          };

          const newInsights = await generateInsights(aiContext);

          if (newInsights && newInsights.length > 0) {
            // Persist insights to UserNotification to avoid bloating User row
            await prisma.userNotification.upsert({
              where: { userId: request.user.id },
              update: {
                aiInsights: JSON.stringify(newInsights),
                lastAiInsightAt: new Date(),
              },
              create: {
                userId: request.user.id,
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

      // Usage Limits Helper (Dynamic from DB)
      const allPlans = await prisma.plan.findMany();
      const planLimits = allPlans.reduce((acc, p) => {
        acc[p.name] = {
          waSends: p.waSends,
          emailSends: p.emailSends,
          aiCredits: p.aiCredits,
          waReminders: p.waReminders,
          emailReminders: p.emailReminders,
          invoices: p.invoices,
        };
        return acc;
      }, {});

      // Fetch global system configuration
      let systemConfig = await prisma.systemConfiguration.findFirst();
      if (!systemConfig) {
        systemConfig = await prisma.systemConfiguration.create({
          data: {
            whatsappEnabled: true,
            emailEnabled: true,
            invoiceCreationEnabled: true,
            paymentsEnabled: true,
            globalNotice: null,
            maintenanceMode: false,
          }
        });
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
        usageLimits: planLimits[plan] || planLimits.FREE || {},
        system: systemConfig,
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
        select: { profile: { select: { defaultCurrency: true } } },
      });
      const targetCurrency = user.profile?.defaultCurrency || "MYR";

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
