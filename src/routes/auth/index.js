const bcrypt = require("bcryptjs");
const {
  screenSignup,
  STATUS: REFERRAL_STATUS,
} = require("../../utils/referral");

async function authRoutes(fastify, opts) {
  const { prisma } = fastify;

  // POST register
  fastify.post("/register", async (request, reply) => {
    const { email, password, name, referralCode } = request.body;

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return reply.badRequest("User already exists");
    }

    /* ── Referral attribution (spec 09) ────────────────────────────────────
       Screened here, at signup, because this is the last moment both sides are
       in front of us and nothing has been paid yet. A referral that fails
       screening is still RECORDED — as REJECTED, with the reason — rather than
       dropped: "why did I not get my credit" needs an answer, and silently
       ignoring the code produces an account that looks like it arrived on its
       own. The reward itself is granted much later, on first payment. */
    let referrerId = null;
    let referralScreen = null;
    let referrerRecord = null;

    if (referralCode) {
      referrerRecord = await prisma.user.findUnique({
        where: { referralCode: String(referralCode).trim().toUpperCase() },
        select: { id: true, email: true },
      });

      referralScreen = screenSignup({
        referrer: referrerRecord,
        candidateEmail: email,
      });

      /* referredById is set only for referrals that PASSED. A rejected one
         leaves the account unattached, so nothing downstream — the dashboard,
         the webhook — has to re-check whether it was legitimate. */
      if (referrerRecord && referralScreen.ok) referrerId = referrerRecord.id;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const crypto = require("crypto");
    const newReferralCode = crypto.randomBytes(4).toString("hex").toUpperCase();

    // Create user + all 5 sub-records in a single atomic transaction
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        plan: "FREE",
        referredById: referrerId,
        referralCode: newReferralCode,
        // Nested creates for sub-models — they inherit defaults from schema
        profile:        { create: { name } },
        quota:          { create: {} },
        notification:   { create: {} },
        invoiceConfig:  { create: {} },
        manualPayment:  { create: {} },
      },
    });

    /* The ledger row. Created after the user exists because it points at both
       accounts, and outside the create above because a failure here must not
       cost somebody their signup — a missing referral record is a support
       ticket, a failed registration is a lost customer. */
    if (referrerRecord) {
      try {
        await prisma.referral.create({
          data: {
            referrerId: referrerRecord.id,
            referredId: user.id,
            status: referralScreen?.ok ? REFERRAL_STATUS.PENDING : REFERRAL_STATUS.REJECTED,
            rejectedReason: referralScreen?.ok ? null : referralScreen?.reason || null,
          },
        });
      } catch (err) {
        /* The unique constraint on referredId makes this idempotent: a retried
           registration cannot produce two ledger rows for one account, and
           therefore cannot pay the reward twice. */
        fastify.log.warn({ err, userId: user.id }, "Referral record not created");
      }
    }

    const accessToken = fastify.jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      { expiresIn: "15m" },
    );
    const refreshToken = fastify.jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      { expiresIn: "7d" },
    );

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name,
        plan: user.plan,
        role: user.role,
        onboardingCompleted: user.onboardingCompleted,
      },
    };
  });

  // POST login
  fastify.post("/login", async (request, reply) => {
    const { email, password } = request.body;

    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        profile: true,
        subscriptions: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            plan: true,
            status: true,
            subscriptionStart: true,
            subscriptionEnds: true,
          },
        },
      },
    });

    if (!user) return reply.unauthorized("Invalid email or password");
    if (!user.isActive) return reply.unauthorized("Account is disabled. Please contact support.");

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) return reply.unauthorized("Invalid email or password");

    const accessToken = fastify.jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      { expiresIn: "15m" },
    );
    const refreshToken = fastify.jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      { expiresIn: "7d" },
    );

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.profile?.name,
        plan: user.plan,
        role: user.role,
        companyPhone: user.profile?.companyPhone,
        reminderInterval: user.notification?.reminderInterval ?? 0,
        onboardingCompleted: user.onboardingCompleted,
        subscriptions: user.subscriptions,
      },
    };
  });

  // POST refresh
  fastify.post("/refresh", async (request, reply) => {
    const { refreshToken } = request.body;
    if (!refreshToken) return reply.unauthorized("No refresh token provided");

    try {
      const decoded = await fastify.jwt.verify(refreshToken);
      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: { isActive: true },
      });

      if (!user || !user.isActive) {
        return reply.unauthorized("Account is disabled or does not exist");
      }

      const accessToken = fastify.jwt.sign(
        { id: decoded.id, email: decoded.email, role: decoded.role },
        { expiresIn: "15m" },
      );

      return { accessToken };
    } catch (err) {
      return reply.unauthorized("Invalid refresh token");
    }
  });

  // POST logout
  fastify.post("/logout", async (request, reply) => {
    return { success: true, message: "Logged out successfully" };
  });
}

module.exports = authRoutes;
