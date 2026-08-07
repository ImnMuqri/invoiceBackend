const fp = require("fastify-plugin");

async function usagePlugin(fastify, opts) {
  const { prisma } = fastify;

  /* Limits come from the Plan table, so what an admin edits is what is actually
     enforced.

     This used to be a hardcoded object, and the product had FOUR disagreeing
     sources of truth: this, the Plan table (which drove the pricing page and
     the dashboard meters), and a stale price fallback in the subscribe route.
     The consequences were not cosmetic — the object had no STARTER key at all,
     and the lookup fell back to Free for anything it did not recognise, so a
     paying Starter customer was enforced at Free limits: 5 invoices and zero
     WhatsApp sends, for RM19 a month. PRO advertised 100 invoices, enforced 30.

     Read through fastify.getPlans(), which is the 60s cache, so this is not a
     database round trip per invoice. The admin plan writer drops that cache, so
     an edit takes effect immediately rather than whenever the TTL lapses. */

  /* At or above this is "unlimited" — the convention the dashboard already used
     to decide whether to draw a usage meter at all. */
  const UNLIMITED = 999999;

  /* The floor, for when a plan name matches no row: a renamed plan, a retired
     one, a typo in a manual database edit. Failing to the most restrictive
     answer is the only safe direction — the alternative is an unrecognised plan
     string granting unlimited everything, which is exactly the tampering route
     worth closing. */
  const SAFETY_FLOOR = {
    invoices: 0, quotes: 0, waSends: 0, emailSends: 0,
    waReminders: 0, emailReminders: 0, ai: 0,
  };

  /** Limits for one plan name, matched case-insensitively. */
  const limitsFor = async (planName) => {
    const plans = (await fastify.getPlans()) || [];
    const wanted = String(planName || "FREE").toUpperCase();

    const row =
      plans.find((p) => p.isActive !== false && String(p.name).toUpperCase() === wanted) ||
      /* An inactive plan is still honoured for whoever is on it: retiring a tier
         must not strip the customers still holding it before they migrate. */
      plans.find((p) => String(p.name).toUpperCase() === wanted) ||
      plans.find((p) => String(p.name).toUpperCase() === "FREE");

    if (!row) {
      fastify.log.error({ plan: planName }, "No Plan row resolved; enforcing the safety floor");
      return SAFETY_FLOOR;
    }

    return {
      invoices: row.invoices,
      quotes: row.quotes,
      waSends: row.waSends,
      emailSends: row.emailSends,
      waReminders: row.waReminders,
      emailReminders: row.emailReminders,
      /* The column is aiCredits; every call site asks for `ai`. */
      ai: row.aiCredits,
      /* Spec 01 additions, read by the chase plugin. */
      chasedInvoices: row.chasedInvoices,
      trialChases: row.trialChases,
      waPerInvoiceCap: row.waPerInvoiceCap,
    };
  };

  const checkAndIncrement = async (userId, type) => {
    // Fetch plan from User and quota from UserQuota in one query
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        plan: true,
        quota: true,
      },
    });

    if (!user) throw new Error("User not found");

    const plan = user.plan || "FREE";
    const limits = await limitsFor(plan);
    const quota = user.quota || {};

    const fieldMap = {
      waSend: "waSendsUsed",
      emailSend: "emailSendsUsed",
      waReminder: "waRemindersUsed",
      emailReminder: "emailRemindersUsed",
      ai: "aiUsed",
      invoice: "invoicesUsed",
      quote: "quotesUsed",
    };
    const limitMap = {
      waSend: "waSends",
      emailSend: "emailSends",
      waReminder: "waReminders",
      emailReminder: "emailReminders",
      ai: "ai",
      invoice: "invoices",
      quote: "quotes",
    };

    const countField = fieldMap[type];
    const limitField = limitMap[type];
    if (!countField || !limitField) throw new Error("Invalid usage type");

    // Reset logic: if a new month has started, reset all quota counters
    const now = new Date();
    const lastReset = quota.lastResetDate ? new Date(quota.lastResetDate) : new Date(0);
    if (now.getMonth() !== lastReset.getMonth() || now.getFullYear() !== lastReset.getFullYear()) {
      await prisma.userQuota.upsert({
        where: { userId },
        update: {
          waSendsUsed: 0,
          emailSendsUsed: 0,
          waRemindersUsed: 0,
          emailRemindersUsed: 0,
          aiUsed: 0,
          invoicesUsed: 0,
          quotesUsed: 0,
          lastResetDate: now,
        },
        create: {
          userId,
          waSendsUsed: 0,
          emailSendsUsed: 0,
          waRemindersUsed: 0,
          emailRemindersUsed: 0,
          aiUsed: 0,
          invoicesUsed: 0,
          quotesUsed: 0,
          lastResetDate: now,
        },
      });
      // Reset in-memory for the immediate check below
      quota.waSendsUsed = 0;
      quota.emailSendsUsed = 0;
      quota.waRemindersUsed = 0;
      quota.emailRemindersUsed = 0;
      quota.aiUsed = 0;
      quota.invoicesUsed = 0;
      quota.quotesUsed = 0;
    }

    const currentCount = quota[countField] ?? 0;
    const allowance = Number(limits[limitField]) || 0;
    if (allowance < UNLIMITED && currentCount >= allowance) {
      const err = new Error(`Monthly limit reached for ${type}`);
      err.statusCode = 403;
      throw err;
    }

    // Increment in UserQuota
    await prisma.userQuota.upsert({
      where: { userId },
      update: { [countField]: { increment: 1 } },
      create: { userId, [countField]: 1 },
    });

    return true;
  };

  const checkOnly = async (userId, type) => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { plan: true, quota: true },
    });

    if (!user) throw new Error("User not found");

    const plan = user.plan || "FREE";
    const limits = await limitsFor(plan);
    const quota = user.quota || {};

    const fieldMap = {
      waSend: "waSendsUsed",
      emailSend: "emailSendsUsed",
      waReminder: "waRemindersUsed",
      emailReminder: "emailRemindersUsed",
      ai: "aiUsed",
      invoice: "invoicesUsed",
      quote: "quotesUsed",
    };
    const limitMap = {
      waSend: "waSends",
      emailSend: "emailSends",
      waReminder: "waReminders",
      emailReminder: "emailReminders",
      ai: "ai",
      invoice: "invoices",
      quote: "quotes",
    };

    const countField = fieldMap[type];
    const limitField = limitMap[type];
    if (!countField || !limitField) throw new Error("Invalid usage type");

    const currentCount = quota[countField] ?? 0;
    const allowance = Number(limits[limitField]) || 0;
    if (allowance < UNLIMITED && currentCount >= allowance) {
      const err = new Error(`Monthly limit reached for ${type}`);
      err.statusCode = 403;
      throw err;
    }

    return true;
  };

  fastify.decorate("usage", { checkAndIncrement, checkOnly, limitsFor, UNLIMITED });
}

module.exports = fp(usagePlugin);
