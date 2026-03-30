async function dashboardRoutes(fastify, opts) {
  console.log("DASHBOARD ROUTES REGISTERING...");
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

      // Usage Limits Helper
      const PLAN_LIMITS = {
        FREE: { waSends: 0, emailSends: 5, aiCredits: 0, waReminders: 0, emailReminders: 0, invoices: 5 },
        PRO: { waSends: 50, emailSends: 100, aiCredits: 20, waReminders: 50, emailReminders: 50, invoices: 30 },
        MAX: { waSends: 100, emailSends: 100, aiCredits: 100, waReminders: 100, emailReminders: 100, invoices: 100 },
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
    console.log("FORECAST REQUEST RECEIVED", request.query);
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

      const user = await prisma.user.findUnique({ where: { id: request.user.id } });
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

      const groupData = (data, dateKey, start, end) => {
        const groups = {};
        
        // Phase 1: Initialize all dates in range
        let d = new Date(start);
        d.setHours(12, 0, 0, 0); // Center in the day for robust keying
        const last = new Date(end);
        last.setHours(12, 0, 0, 0);
        
        while (d <= last) {
          const key = d.toISOString().split("T")[0];
          groups[key] = { amount: 0, details: [] };
          d.setDate(d.getDate() + 1);
        }

        // Phase 2: Process actual data
        for (const item of data) {
          const date = new Date(item[dateKey]);
          const key = date.toISOString().split("T")[0];
          
          if (groups[key]) {
            const converted = convertAmount(item.amount, item.currency, targetCurrency);
            groups[key].amount = (groups[key].amount || 0) + converted;
            
            // Ensure details are ALWAYS pushed if amount is added
            groups[key].details.push({
              clientName: item.client?.name || "N/A",
              clientId: item.clientId || "Unknown",
              invoiceNumber: item.invoiceNumber || item.id,
              amount: parseFloat(converted.toFixed(2)),
              dueDate: item.dueDate || item.date
            });
          }
        }
        
        // Phase 3: Finalize and return as sorted array
        return Object.keys(groups).sort().map((date) => {
          const group = groups[date];
          return { 
            date, 
            amount: parseFloat((group.amount || 0).toFixed(2)),
            details: group.details.length > 0 ? group.details : []
          };
        });
      };

      return {
        cashflow: {
          history: groupData(paidInvoices, "date", historyStartDate, now),
          forecast: groupData(pendingInvoices, "dueDate", now, forecastEndDate),
        },
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to fetch forecast data");
    }
  });
}

module.exports = dashboardRoutes;
