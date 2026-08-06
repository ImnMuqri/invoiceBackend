async function dashboardRoutes(fastify, opts) {
  const { prisma } = fastify;
  const { convertAmount } = require("../../utils/currency");

  // Apply authentication to all routes in this plugin
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/core", async (request, reply) => {
    try {
      const now = new Date();

      // Get user's default currency, plan, and current quota usage
      const user = await prisma.user.findUnique({
        where: { id: request.user.id },
        select: {
          plan: true,
          profile: { select: { defaultCurrency: true } },
          notification: { select: { aiInsights: true, lastAiInsightAt: true } },
          quota: {
            select: {
              invoicesUsed: true,
              waSendsUsed: true,
              emailSendsUsed: true,
              waRemindersUsed: true,
              emailRemindersUsed: true,
              aiUsed: true,
            },
          },
        },
      });
      const targetCurrency = user.profile?.defaultCurrency || "MYR";
      const plan = user.plan || "FREE";

      const { rank = "top5" } = request.query;

      /* One round trip instead of five.
         These queries do not depend on each other, but they were awaited one
         after another — and on Railway the app and the database are separate
         services, so each await is a full network round trip. The page now
         waits for the slowest rather than the sum.

         The totals query is a groupBy rather than a findMany for the same
         reason — see the comment on it below. */
      const [invoiceTotals, overdueCount, activeClientsCount, recentInvoices, topClientsRaw] =
        await Promise.all([
          /* Sum in the database, not in Node.
             This used to transfer every invoice the user has ever raised in
             order to add up two subsets. Grouping by (status, currency) returns
             a handful of rows no matter how many invoices there are — the
             currency split is what makes it possible to still convert in JS,
             because each subtotal is already in a single currency. */
          prisma.invoice.groupBy({
            by: ["status", "currency"],
            where: { kind: "INVOICE", userId: request.user.id },
            /* amountPaid too: an invoice's contribution to "outstanding" is
               what is LEFT on it, not its face value. */
            _sum: { amount: true, amountPaid: true },
          }),
          prisma.invoice.count({
            where: {
              kind: "INVOICE",
              userId: request.user.id,
              OR: [
                { status: "Overdue" },
                /* Partially Paid past its due date is still late. It was
                   missing here, so paying part of a late invoice made it
                   disappear from the overdue count. */
                { status: { in: ["Pending", "Partially Paid"] }, dueDate: { lt: now } },
              ],
            },
          }),
          prisma.client.count({ where: { userId: request.user.id } }),
          prisma.invoice.findMany({
            where: { kind: "INVOICE", userId: request.user.id },
            take: 5,
            orderBy: { date: "desc" },
            include: { client: true },
          }),
          prisma.invoice.groupBy({
            by: ["clientId"],
            where: { kind: "INVOICE", userId: request.user.id, status: "Paid" },
            _sum: { amount: true },
            orderBy: { _sum: { amount: rank === "bottom5" ? "asc" : "desc" } },
            take: plan === "FREE" ? 1 : 5,
          }),
        ]);

      /* "Partially Paid" is a real status — the PUT handler sets it whenever a
         payment lands that does not cover the total, and the reminder cron
         chases it. Neither figure below knew about it:

           - outstanding filtered ["Pending", "Overdue"], so an invoice with a
             part payment against it counted as ZERO owed. Take RM200 on a
             RM500 invoice and the RM300 still due vanished from the dashboard.
           - revenue counted only invoices marked Paid, so the RM200 that had
             actually arrived was not counted either. The money was in neither
             number.

         Both now work from what has been received rather than from the label. */
      const isSettled = (s) => s === "Paid";
      const isDead = (s) => s === "Cancelled";

      const convertRow = (value, row) =>
        convertAmount(value || 0, row.currency, targetCurrency);

      const totalRevenue = invoiceTotals.reduce((sum, row) => {
        if (isDead(row.status)) return sum;
        /* A settled invoice contributes its face value: older rows were marked
           Paid by paths that never wrote amountPaid, so trusting that column
           alone here would silently erase historical revenue. Everything else
           contributes only what has actually been received. */
        const received = isSettled(row.status)
          ? row._sum.amount
          : row._sum.amountPaid;
        return sum + convertRow(received, row);
      }, 0);

      const outstandingAmount = invoiceTotals.reduce((sum, row) => {
        if (isSettled(row.status) || isDead(row.status)) return sum;
        /* Floored at zero so an overpayment on one invoice cannot subtract from
           what another still owes. */
        const left = Math.max(0, (row._sum.amount || 0) - (row._sum.amountPaid || 0));
        return sum + convertRow(left, row);
      }, 0);

      /* Two queries, not 1 + 2N.
         This used to loop the top clients and, for each, run a findUnique AND
         pull every paid invoice they have ever had — 11 round trips for five
         clients, re-reading the full payment history on every dashboard load.
         Both are now single batched queries over the same id set. */
      const topClientIds = topClientsRaw.map((r) => r.clientId).filter(Boolean);

      const [topClientRecords, topClientInvoices] = await Promise.all([
        topClientIds.length
          ? prisma.client.findMany({
              where: { id: { in: topClientIds }, userId: request.user.id },
              select: {
                id: true,
                name: true,
                profitMargin: true,
                averageDelayDays: true,
                status: true,
              },
            })
          : [],
        topClientIds.length
          ? prisma.invoice.findMany({
              where: {
                kind: "INVOICE",
                clientId: { in: topClientIds },
                userId: request.user.id,
                status: "Paid",
              },
              select: { clientId: true, amount: true, currency: true },
            })
          : [],
      ]);

      const clientById = new Map(topClientRecords.map((c) => [c.id, c]));
      const revenueByClient = new Map();
      for (const inv of topClientInvoices) {
        revenueByClient.set(
          inv.clientId,
          (revenueByClient.get(inv.clientId) || 0) +
            convertAmount(inv.amount, inv.currency, targetCurrency),
        );
      }

      const topClients = topClientsRaw.map((raw) => {
        const client = clientById.get(raw.clientId);
        return {
          id: client?.id || raw.clientId,
          name: client?.name || "Deleted Client",
          totalRevenue: revenueByClient.get(raw.clientId) || 0,
          profitMargin: client?.profitMargin || 25,
          averageDelayDays: client?.averageDelayDays || 0,
          status: client?.status || "Active",
        };
      });

      // Fetch overdue invoices for AI context
      const overdueInvoicesContext = await prisma.invoice.findMany({
        where: {
          kind: "INVOICE",
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
      const allPlans = await fastify.getPlans();
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

      // Cached; see the prisma plugin for the TTL and why.
      const systemConfig = await fastify.getSystemConfig();

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
        // Current quota usage — avoids a separate /me call on dashboard load
        quotaUsage: {
          invoicesUsed: user.quota?.invoicesUsed ?? 0,
          waSendsUsed: user.quota?.waSendsUsed ?? 0,
          emailSendsUsed: user.quota?.emailSendsUsed ?? 0,
          waRemindersUsed: user.quota?.waRemindersUsed ?? 0,
          emailRemindersUsed: user.quota?.emailRemindersUsed ?? 0,
          aiUsed: user.quota?.aiUsed ?? 0,
        },
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
          kind: "INVOICE",
          userId: request.user.id,
          status: "Paid",
          date: { gte: historyStartDate, lte: now },
        },
        include: { client: true },
      });

      const pendingInvoices = await prisma.invoice.findMany({
        where: {
          kind: "INVOICE",
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
