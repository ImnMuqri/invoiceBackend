async function referralRoutes(fastify, opts) {
  const { prisma } = fastify;

  // Apply authentication
  fastify.addHook("onRequest", fastify.authenticate);

  // GET /api/referral/stats
  fastify.get("/stats", async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: {
        referralCode: true,
        referralCredits: true,
        _count: {
          select: { referrals: true },
        },
      },
    });

    // Generate referral code if missing (for legacy users)
    if (!user.referralCode) {
      const crypto = require("crypto");
      const newCode = crypto.randomBytes(4).toString("hex").toUpperCase();
      const updatedUser = await prisma.user.update({
        where: { id: request.user.id },
        data: { referralCode: newCode },
        select: {
          referralCode: true,
          referralCredits: true,
          _count: {
            select: { referrals: true },
          },
        },
      });
      return {
        referralCode: updatedUser.referralCode,
        referralCredits: updatedUser.referralCredits,
        totalReferrals: updatedUser._count.referrals,
      };
    }

    return {
      referralCode: user.referralCode,
      referralCredits: user.referralCredits,
      totalReferrals: user._count.referrals,
    };
  });

  // POST /api/referral/claim
  fastify.post("/claim", async (request, reply) => {
    const { rewardType } = request.body; // "PRO" or "MAX"
    const cost = rewardType === "PRO" ? 5 : 10;

    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
    });

    if (user.referralCredits < cost) {
      return reply.badRequest("Insufficient referral credits");
    }

    // Update user credits and plan
    // For simplicity, we just update the plan and reset the subscription end date to 1 month from now
    const now = new Date();
    const expiry = new Date();
    expiry.setMonth(expiry.getMonth() + 1);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          referralCredits: { decrement: cost },
          plan: rewardType,
        },
      }),
      prisma.subscription.create({
        data: {
          userId: user.id,
          plan: rewardType,
          amount: 0,
          status: "ACTIVE",
          subscriptionStart: now,
          subscriptionEnds: expiry,
        },
      }),
    ]);

    return { message: `Successfully claimed 1 month of ${rewardType}!` };
  });
}

module.exports = referralRoutes;
