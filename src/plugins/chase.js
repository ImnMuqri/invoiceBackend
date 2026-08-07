const fp = require("fastify-plugin");

/**
 * Chased-invoice metering (spec 01).
 *
 * The metered unit is the CHASED INVOICE, not the message. One chased invoice
 * covers the first WhatsApp message sent for an invoice plus every follow-up
 * reminder for that same invoice in the same billing period. Invoice creation
 * and email are not metered on paid plans, because neither costs anything real
 * to serve — WhatsApp does, and it was the number quietly running out while the
 * pricing page advertised a different one.
 *
 * The rule that matters most in this file is the last one: a scheduled reminder
 * is NEVER silently dropped. When the allowance is gone the message goes by
 * email and is recorded as downgraded. An invoice chased twice and then
 * abandoned is worse than one never chased, because the user blames us for the
 * unpaid invoice rather than the client.
 *
 * Consumption order: plan allowance, then trial grant, then top-up balance.
 * Top-ups last because they are the only part the user paid extra for — burning
 * those while a free monthly allowance sits unused would be theft by ordering.
 */

/** "YYYY-MM" in Asia/Kuala_Lumpur — the user's month, not the server's. */
function periodKey(date = new Date()) {
  /* en-CA gives YYYY-MM-DD, which slices cleanly and avoids assembling a date
     string by hand from parts that vary by locale. */
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return ymd.slice(0, 7);
}

async function chasePlugin(fastify, opts) {
  const { prisma } = fastify;

  /** The plan's limits, preferring a subscription's frozen snapshot. */
  const allowancesFor = async (userId) => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        plan: true,
        quota: { select: { trialChasesUsed: true } },
        subscriptions: {
          where: { status: "ACTIVE" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { allowances: true },
        },
      },
    });
    if (!user) return null;

    /* A live subscription's snapshot wins. Editing a Plan row must not silently
       change what an existing subscriber already bought. */
    const frozen = user.subscriptions?.[0]?.allowances;
    const live = await fastify.usage.limitsFor(user.plan);
    const planRow = (await fastify.getPlans())?.find(
      (p) => String(p.name).toUpperCase() === String(user.plan || "FREE").toUpperCase(),
    );

    return {
      chasedInvoices: frozen?.chasedInvoices ?? planRow?.chasedInvoices ?? 0,
      trialChases: frozen?.trialChases ?? planRow?.trialChases ?? 0,
      waPerInvoiceCap: frozen?.waPerInvoiceCap ?? planRow?.waPerInvoiceCap ?? 6,
      trialChasesUsed: user.quota?.trialChasesUsed ?? 0,
      limits: live,
    };
  };

  const usageFor = async (userId, key = periodKey()) =>
    prisma.usagePeriod.upsert({
      where: { userId_periodKey: { userId, periodKey: key } },
      update: {},
      create: { userId, periodKey: key },
    });

  /** Unconsumed top-up balance for this period. */
  const topUpBalance = async (userId, key = periodKey()) => {
    const rows = await prisma.topUp.findMany({
      where: { userId, periodKey: key, status: "ACTIVE" },
      select: { chasedInvoices: true, consumed: true },
    });
    return rows.reduce((n, t) => n + Math.max(0, t.chasedInvoices - t.consumed), 0);
  };

  /**
   * Can a WhatsApp message go out for this invoice right now?
   *
   * Returns { allowed, alreadyCounted, source, reason }. It does NOT consume —
   * call consumeChase after the message is actually accepted by the provider,
   * so a provider failure does not silently burn allowance.
   */
  const canChase = async (userId, invoiceId) => {
    const key = periodKey();
    const [a, invoice] = await Promise.all([
      allowancesFor(userId),
      prisma.invoice.findUnique({
        where: { id: invoiceId },
        select: { chasedInPeriod: true, waMessageCount: true },
      }),
    ]);
    if (!a) return { allowed: false, reason: "no such account" };
    if (!invoice) return { allowed: false, reason: "no such invoice" };

    /* The per-invoice ceiling applies whether or not the invoice is already
       counted. One invoice must not be able to drain the account through
       repeated manual sends. */
    if (invoice.waMessageCount >= a.waPerInvoiceCap) {
      return {
        allowed: false,
        reason: `per-invoice WhatsApp cap of ${a.waPerInvoiceCap} reached`,
      };
    }

    /* Already counted this period: reminders two, three and four are free. */
    if (invoice.chasedInPeriod === key) {
      return { allowed: true, alreadyCounted: true, source: "counted" };
    }

    const usage = await usageFor(userId, key);

    if (usage.chasedInvoices < a.chasedInvoices) {
      return { allowed: true, alreadyCounted: false, source: "plan" };
    }
    if (a.trialChasesUsed < a.trialChases) {
      return { allowed: true, alreadyCounted: false, source: "trial" };
    }
    if ((await topUpBalance(userId, key)) > 0) {
      return { allowed: true, alreadyCounted: false, source: "topup" };
    }

    return { allowed: false, reason: "chased invoice allowance exhausted" };
  };

  /**
   * Record that a WhatsApp message went out. Increments the per-invoice counter
   * always, and the period counter only the first time for that invoice.
   */
  const consumeChase = async (userId, invoiceId, decision) => {
    const key = periodKey();

    await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        waMessageCount: { increment: 1 },
        ...(decision.alreadyCounted ? {} : { chasedInPeriod: key }),
      },
    });

    await prisma.usagePeriod.upsert({
      where: { userId_periodKey: { userId, periodKey: key } },
      update: {
        waMessages: { increment: 1 },
        ...(decision.alreadyCounted ? {} : { chasedInvoices: { increment: 1 } }),
      },
      create: {
        userId,
        periodKey: key,
        waMessages: 1,
        chasedInvoices: decision.alreadyCounted ? 0 : 1,
      },
    });

    if (decision.alreadyCounted) return;

    if (decision.source === "trial") {
      await prisma.userQuota.upsert({
        where: { userId },
        update: { trialChasesUsed: { increment: 1 } },
        create: { userId, trialChasesUsed: 1 },
      });
    } else if (decision.source === "topup") {
      /* Spend the oldest top-up first, so a balance bought earlier in the period
         cannot expire while a newer one is drained. */
      const row = await prisma.topUp.findFirst({
        where: { userId, periodKey: key, status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
      });
      if (row && row.consumed < row.chasedInvoices) {
        await prisma.topUp.update({
          where: { id: row.id },
          data: { consumed: { increment: 1 } },
        });
      }
    }
  };

  /** Append to the message log. Never throws into the send path. */
  const logMessage = async (entry) => {
    try {
      await prisma.messageLog.create({ data: entry });
      if (entry.channel === "EMAIL") {
        await prisma.usagePeriod.upsert({
          where: { userId_periodKey: { userId: entry.userId, periodKey: periodKey() } },
          update: {
            emailMessages: { increment: 1 },
            ...(entry.downgraded ? { downgrades: { increment: 1 } } : {}),
          },
          create: {
            userId: entry.userId,
            periodKey: periodKey(),
            emailMessages: 1,
            downgrades: entry.downgraded ? 1 : 0,
          },
        });
      }
    } catch (err) {
      fastify.log.warn({ err }, "Failed to write message log");
    }
  };

  /**
   * Tell the account owner, at most once per period, that their WhatsApp
   * allowance is spent and reminders are going by email. One notification per
   * period, not one per downgraded message — the second is how a useful warning
   * becomes noise the user filters out.
   */
  const notifyDowngradeOnce = async (userId) => {
    const key = periodKey();
    const usage = await usageFor(userId, key);
    if (usage.downgradeNotified) return;

    await prisma.usagePeriod.update({
      where: { userId_periodKey: { userId, periodKey: key } },
      data: { downgradeNotified: true },
    });

    try {
      const { createNotification } = require("../utils/notificationUtils");
      await createNotification(
        prisma,
        userId,
        "WhatsApp allowance used up",
        "Reminders are still going out — by email instead of WhatsApp — until your allowance resets or you top up.",
        "USAGE",
      );
    } catch (err) {
      fastify.log.warn({ err }, "Failed to notify about WhatsApp downgrade");
    }
  };

  /** The dashboard usage panel reads this. */
  const usageSummary = async (userId) => {
    const key = periodKey();
    const [a, usage, topup] = await Promise.all([
      allowancesFor(userId),
      usageFor(userId, key),
      topUpBalance(userId, key),
    ]);
    if (!a) return null;

    /* Days until the allowance resets, in Kuala Lumpur time. */
    const now = new Date();
    const [y, m] = key.split("-").map(Number);
    const nextReset = Date.UTC(y, m, 1) - 8 * 60 * 60 * 1000; // MYT is UTC+8
    const daysUntilReset = Math.max(
      0,
      Math.ceil((nextReset - now.getTime()) / 86400000),
    );

    return {
      periodKey: key,
      chasedInvoicesUsed: usage.chasedInvoices,
      chasedInvoicesAllowance: a.chasedInvoices,
      trialRemaining: Math.max(0, a.trialChases - a.trialChasesUsed),
      topUpRemaining: topup,
      downgrades: usage.downgrades,
      waMessages: usage.waMessages,
      emailMessages: usage.emailMessages,
      daysUntilReset,
    };
  };

  fastify.decorate("chase", {
    periodKey,
    canChase,
    consumeChase,
    logMessage,
    notifyDowngradeOnce,
    usageSummary,
    allowancesFor,
    topUpBalance,
  });
}

module.exports = fp(chasePlugin);
