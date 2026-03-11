const fp = require("fastify-plugin");

async function usagePlugin(fastify, opts) {
  const { prisma } = fastify;

  const LIMITS = {
    FREE: {
      waSends: 0,
      emailSends: 0,
      waReminders: 0,
      emailReminders: 0,
      ai: 0,
    },
    PRO: {
      waSends: 30,
      emailSends: 30,
      waReminders: 100,
      emailReminders: 100,
      ai: 10,
    },
    MAX: {
      waSends: 100,
      emailSends: 100,
      waReminders: 100,
      emailReminders: 100,
      ai: 50,
    },
  };

  const checkAndIncrement = async (userId, type) => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) throw new Error("User not found");

    const plan = user.plan || "FREE";
    const limits = LIMITS[plan] || LIMITS.FREE;

    // Reset logic if month has passed
    const now = new Date();
    const lastReset = new Date(user.lastResetDate);
    if (
      now.getMonth() !== lastReset.getMonth() ||
      now.getFullYear() !== lastReset.getFullYear()
    ) {
      await prisma.user.update({
        where: { id: userId },
        data: {
          waSendsUsed: 0,
          emailSendsUsed: 0,
          waRemindersUsed: 0,
          emailRemindersUsed: 0,
          aiUsed: 0,
          lastResetDate: now,
        },
      });
      // Re-fetch limits after reset
      user.waSendsUsed = 0;
      user.emailSendsUsed = 0;
      user.waRemindersUsed = 0;
      user.emailRemindersUsed = 0;
      user.aiUsed = 0;
    }

    const fieldMap = {
      waSend: "waSendsUsed",
      emailSend: "emailSendsUsed",
      waReminder: "waRemindersUsed",
      emailReminder: "emailRemindersUsed",
      ai: "aiUsed",
    };

    const limitMap = {
      waSend: "waSends",
      emailSend: "emailSends",
      waReminder: "waReminders",
      emailReminder: "emailReminders",
      ai: "ai",
    };

    const countField = fieldMap[type];
    const limitField = limitMap[type];

    if (!countField || !limitField) throw new Error("Invalid usage type");

    if (user[countField] >= limits[limitField]) {
      const err = new Error(`Monthly limit reached for ${type}`);
      err.statusCode = 403;
      throw err;
    }

    // Increment
    await prisma.user.update({
      where: { id: userId },
      data: {
        [countField]: { increment: 1 },
      },
    });

    return true;
  };

  fastify.decorate("usage", {
    checkAndIncrement,
    LIMITS,
  });
}

module.exports = fp(usagePlugin);
