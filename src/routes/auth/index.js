const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { getPasswordResetEmail, RESET_TTL_MINUTES } = require("../../utils/passwordResetEmail");
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

  /* ── Password reset ──────────────────────────────────────────────────────
     Three steps: ask for a link (email), check a link (when the page opens),
     spend a link (set the new password).

     - The raw token only ever exists in the email. The table stores its
       SHA-256, so a leaked row is not a working link.
     - /forgot-password answers the same way whether or not the email has an
       account. Saying "no such account" would let anyone test which emails
       are customers.
     - Tight per-IP rate limits on all three, on top of the global one. */

  const hashToken = (raw) => crypto.createHash("sha256").update(raw).digest("hex");
  const PASSWORD_MIN = 8;

  async function findLiveToken(raw) {
    if (!raw || typeof raw !== "string" || raw.length > 200) return null;
    const row = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(raw) },
      include: { user: { select: { id: true, email: true, isActive: true } } },
    });
    if (!row || row.usedAt || row.expiresAt <= new Date() || !row.user?.isActive) return null;
    return row;
  }

  // POST forgot-password — always 200, sends an email only if the account exists
  fastify.post(
    "/forgot-password",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const email = String(request.body?.email || "").trim().toLowerCase();
      const locale = request.body?.locale === "ms" ? "ms" : "en";
      const generic = { success: true };

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return generic;

      const user = await prisma.user.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
        select: { id: true, email: true, isActive: true, profile: { select: { name: true } } },
      });
      if (!user || !user.isActive) return generic;

      const raw = crypto.randomBytes(32).toString("base64url");
      const now = new Date();

      await prisma.$transaction([
        // A new link spends every older unused one.
        prisma.passwordResetToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: now },
        }),
        prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash: hashToken(raw),
            expiresAt: new Date(now.getTime() + RESET_TTL_MINUTES * 60_000),
          },
        }),
      ]);

      const base = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");
      const link = `${base}/reset-password?token=${encodeURIComponent(raw)}`;
      const { subject, html, text } = getPasswordResetEmail({
        name: user.profile?.name,
        link,
        locale,
      });

      try {
        await fastify.email.send({ to: user.email, subject, html, text });
      } catch (err) {
        /* Logged, not surfaced: the response must not differ for real accounts,
           and the person can simply ask again. */
        fastify.log.error({ err, userId: user.id }, "Password reset email failed");
      }

      return generic;
    },
  );

  // POST reset-password/check — is this link still usable? (page load)
  fastify.post(
    "/reset-password/check",
    { config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const row = await findLiveToken(request.body?.token);
      if (!row) return { valid: false };
      return { valid: true, email: row.user.email };
    },
  );

  // POST reset-password — spend the link and set the new password
  fastify.post(
    "/reset-password",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const { token, password } = request.body || {};

      if (typeof password !== "string" || password.length < PASSWORD_MIN) {
        return reply.badRequest(`Password must be at least ${PASSWORD_MIN} characters.`);
      }

      const row = await findLiveToken(token);
      if (!row) return reply.badRequest("This reset link is invalid or has expired.");

      const hashed = await bcrypt.hash(password, 10);
      const now = new Date();

      await prisma.$transaction([
        prisma.user.update({ where: { id: row.userId }, data: { password: hashed } }),
        // Spend this link and any others still outstanding for the account.
        prisma.passwordResetToken.updateMany({
          where: { userId: row.userId, usedAt: null },
          data: { usedAt: now },
        }),
      ]);

      return { success: true };
    },
  );
}

module.exports = authRoutes;
