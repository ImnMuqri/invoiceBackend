const fp = require("fastify-plugin");

async function usagePlugin(fastify, opts) {
  const { prisma } = fastify;

  const LIMITS = {
    FREE: { invoices: 5, waSends: 0, emailSends: 5, waReminders: 0, emailReminders: 0, ai: 2 },
    PRO:  { invoices: 30, waSends: 30, emailSends: 50, waReminders: 30, emailReminders: 50, ai: 20 },
    MAX:  { invoices: 100, waSends: 100, emailSends: 100, waReminders: 100, emailReminders: 100, ai: 50 },
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
    const limits = LIMITS[plan] || LIMITS.FREE;
    const quota = user.quota || {};

    const fieldMap = {
      waSend: "waSendsUsed",
      emailSend: "emailSendsUsed",
      waReminder: "waRemindersUsed",
      emailReminder: "emailRemindersUsed",
      ai: "aiUsed",
      invoice: "invoicesUsed",
    };
    const limitMap = {
      waSend: "waSends",
      emailSend: "emailSends",
      waReminder: "waReminders",
      emailReminder: "emailReminders",
      ai: "ai",
      invoice: "invoices",
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
    }

    const currentCount = quota[countField] ?? 0;
    if (currentCount >= limits[limitField]) {
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
    const limits = LIMITS[plan] || LIMITS.FREE;
    const quota = user.quota || {};

    const fieldMap = {
      waSend: "waSendsUsed",
      emailSend: "emailSendsUsed",
      waReminder: "waRemindersUsed",
      emailReminder: "emailRemindersUsed",
      ai: "aiUsed",
      invoice: "invoicesUsed",
    };
    const limitMap = {
      waSend: "waSends",
      emailSend: "emailSends",
      waReminder: "waReminders",
      emailReminder: "emailReminders",
      ai: "ai",
      invoice: "invoices",
    };

    const countField = fieldMap[type];
    const limitField = limitMap[type];
    if (!countField || !limitField) throw new Error("Invalid usage type");

    const currentCount = quota[countField] ?? 0;
    if (currentCount >= limits[limitField]) {
      const err = new Error(`Monthly limit reached for ${type}`);
      err.statusCode = 403;
      throw err;
    }

    return true;
  };

  fastify.decorate("usage", { checkAndIncrement, checkOnly, LIMITS });
}

module.exports = fp(usagePlugin);
