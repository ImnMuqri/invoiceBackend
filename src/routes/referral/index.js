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
    /* rewardType came straight off the request body and was written into
       user.plan unchecked, with `cost = rewardType === "PRO" ? 5 : 10` — so any
       string that was not "PRO" cost 10 credits and became the caller's plan.
       POSTing {"rewardType":"ANYTHING"} wrote ANYTHING into the plan column.

       That is no longer an escalation, because usage.js resolves an unknown
       plan to FREE, but it is still a user writing arbitrary data into the
       column that governs their entitlements — and before that change it was a
       genuine self-upgrade. Only real, active, paid plans are claimable, and
       the price is looked up rather than inferred from "not PRO". */
    const REWARD_COST = { PRO: 5, MAX: 10 };

    const wanted = String(request.body?.rewardType || "").toUpperCase();
    const cost = REWARD_COST[wanted];
    if (!cost) {
      return reply.badRequest("That is not a claimable reward.");
    }

    const plans = (await fastify.getPlans()) || [];
    const rewardPlan = plans.find(
      (p) => p.isActive !== false && String(p.name).toUpperCase() === wanted,
    );
    if (!rewardPlan) {
      return reply.badRequest("That plan is not available right now.");
    }
    const rewardType = rewardPlan.name;

    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
    });

    if (!user) return reply.unauthorized();
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
