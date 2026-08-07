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
            _sum: { amount: true, amountPaid: true, amountDue: true },
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
      /* Void and Cancelled are both excluded from receivables — neither is owed. */
      const isDead = (s) => s === "Cancelled" || s === "Void";

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
        /* amountDue, not amount minus amountPaid: spec 03 makes amountDue the
           one figure that already accounts for credit notes as well, and the
           chaser reads the same column. Two ways of computing "what is owed"
           is how the dashboard and the reminder end up disagreeing.
           Floored at zero so an overpayment on one invoice cannot subtract from
           what another still owes. */
        return sum + convertRow(Math.max(0, row._sum.amountDue || 0), row);
      }, 0);

      /* Partially paid gets its own bucket rather than being folded into
         overdue. Money that has started arriving is a different situation from
         money that has not, and the spec asks for it to be visible as such. */
      const partiallyPaid = invoiceTotals
        .filter((row) => row.status === "Partially Paid")
        .reduce(
          (sum, row) => sum + convertRow(Math.max(0, row._sum.amountDue || 0), row),
          0,
        );

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

          /* RINGGIT, not sen — deliberately, and the only place the dashboard
             hands out anything but sen.

             The model writes prose the user reads ("you have RM2,300
             outstanding"). Fed sen it wrote confident sentences quoting figures
             a hundred times too large, which is worse than a wrong number in a
             table: it reads as a considered observation about the business. */
          const forProse = (v) => Number((Number(v || 0) / 100).toFixed(2));
          const aiContext = {
            currency: targetCurrency,
            totalRevenue: forProse(totalRevenue),
            outstandingAmount: forProse(outstandingAmount),
            overdueInvoices: overdueInvoicesContext.map((inv) => ({
              invoiceNumber: inv.invoiceNumber,
              clientName: inv.client?.name,
              amount: forProse(inv.amount),
              amountDue: forProse(inv.amountDue),
              dueDate: inv.dueDate,
              currency: inv.currency,
            })),
            topClients: topClients.map((c) => ({
              ...c,
              totalRevenue: forProse(c.totalRevenue),
            })),
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
          /* Sen. Rounded because currency conversion is the one place a
             fraction of a sen can appear. */
          totalRevenue: Math.round(totalRevenue),
          outstandingAmount: Math.round(outstandingAmount),
          partiallyPaid: Math.round(partiallyPaid),
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

  /**
   * GET /api/dashboard/quotes — the two quotation lists worth a glance (spec 07).
   *
   * Its own endpoint rather than more fields on /core, and the reason is the
   * spec's hardest rule: a quotation is NOT money owed and must never appear in
   * receivables. /core is where outstanding, overdue and revenue are computed,
   * and every one of those queries carries `kind: "INVOICE"` for exactly that
   * reason. Putting quote figures in the same response is how, two refactors
   * from now, somebody folds one into a total. Separate endpoint, separate
   * numbers, no shared reduce to accidentally join.
   *
   * Two lists, because they are two different jobs:
   *
   *   waiting  — sent, nobody has answered. Sorted oldest first: the quote that
   *              has been out three weeks is the one worth a phone call, and
   *              newest-first buries it.
   *   won      — accepted and NOT yet invoiced. This is the valuable one. It is
   *              work already agreed and not yet billed, which is the single
   *              most useful thing this product can put in front of somebody.
   */
  fastify.get("/quotes", async (request, reply) => {
    try {
      const { effectiveStatus, isExpired } = require("../../utils/quoteLifecycle");

      const user = await prisma.user.findUnique({
        where: { id: request.user.id },
        select: { profile: { select: { defaultCurrency: true } } },
      });
      const targetCurrency = user?.profile?.defaultCurrency || "MYR";

      const select = {
        id: true,
        invoiceNumber: true,
        invoiceName: true,
        subject: true,
        status: true,
        amount: true,
        currency: true,
        date: true,
        validUntil: true,
        viewedAt: true,
        acceptedAt: true,
        acceptedName: true,
        client: { select: { id: true, name: true, company: true } },
      };

      /* Deliberately NOT paged in the query.
         An earlier version took 20 rows and then summed those, so the two
         headline figures silently described the first twenty quotations rather
         than the pipeline — a total that is quietly wrong is worse than no
         total, because nobody checks it. The expiry filter has the same
         problem: applied after a take, it shrinks the page instead of the set.
         So the full sets are read, filtered and summed, and only the LISTS are
         capped, at the bottom. This audience has tens of quotations, not
         thousands, and the invoice endpoints already read unbounded. */
      const [waitingRaw, wonRaw] = await Promise.all([
        prisma.invoice.findMany({
          where: {
            kind: "QUOTE",
            userId: request.user.id,
            status: { in: ["Sent", "Viewed"] },
          },
          select,
          /* Oldest first: the quotation that has been out three weeks is the
             one worth a phone call, and newest-first buries it. */
          orderBy: { date: "asc" },
        }),
        prisma.invoice.findMany({
          where: {
            kind: "QUOTE",
            userId: request.user.id,
            status: "Accepted",
            /* Not yet billed. The relation is the only honest test — a status
               cannot tell you whether an invoice exists, and the unique
               constraint on convertedFromId means there is at most one. */
            convertedTo: { is: null },
          },
          select,
          /* nulls: "last" is load-bearing. Postgres sorts NULLs FIRST on DESC,
             and every quotation accepted before this spec shipped has a null
             acceptedAt — so the default would have put the oldest, least
             relevant rows at the top of the list and let them fill it. */
          orderBy: { acceptedAt: { sort: "desc", nulls: "last" } },
        }),
      ]);

      /* Lapsed-but-not-yet-swept quotes drop out of "waiting" here rather than
         being listed as live. The nightly job will relabel them; until it does,
         this page must not tell somebody a dead quotation is still in play. */
      const now = new Date();
      const waiting = waitingRaw
        .filter((q) => !isExpired(q, now))
        .map((q) => ({
          ...q,
          status: effectiveStatus(q, now),
          ageDays: Math.max(
            0,
            Math.floor((now.getTime() - new Date(q.date).getTime()) / 86400000),
          ),
        }));

      const won = wonRaw.map((q) => ({
        ...q,
        status: effectiveStatus(q, now),
        ageDays: Math.max(
          0,
          Math.floor(
            (now.getTime() - new Date(q.acceptedAt || q.date).getTime()) / 86400000,
          ),
        ),
      }));

      /* Converted to the user's currency so the two headline figures are
         addable, the same way /core does it. Sen throughout. */
      const total = (rows) =>
        Math.round(
          rows.reduce(
            (sum, q) => sum + convertAmount(q.amount || 0, q.currency, targetCurrency),
            0,
          ),
        );

      /* Totals over EVERYTHING, lists capped for display. The counts travel
         alongside so the page can say "showing 20 of 47" rather than implying
         the list is the whole set. */
      const LIST_CAP = 20;

      return {
        currency: targetCurrency,
        waiting: waiting.slice(0, LIST_CAP),
        won: won.slice(0, LIST_CAP),
        waitingCount: waiting.length,
        wonCount: won.length,
        /* Named for what they are, never "outstanding" or "due". The words on
           this payload end up on screen, and a quotation total labelled like a
           receivable is how it gets read as one. */
        waitingValue: total(waiting),
        wonValue: total(won),
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to fetch quotation summary");
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
