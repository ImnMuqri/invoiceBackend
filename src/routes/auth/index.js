const bcrypt = require("bcryptjs");

async function authRoutes(fastify, opts) {
  const { prisma } = fastify;

  // POST register
  fastify.post("/register", async (request, reply) => {
    const { email, password, name, referralCode } = request.body;

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return reply.badRequest("User already exists");
    }

    let referrerId = null;
    if (referralCode) {
      const referrer = await prisma.user.findUnique({ where: { referralCode } });
      if (referrer) referrerId = referrer.id;
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
