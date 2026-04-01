async function adminRoutes(fastify, opts) {
  const { prisma } = fastify;

  // Global preHandler for all routes in this plugin
  // Moving hooks to preHandler ensures they run AFTER CORS handling
  fastify.addHook("preHandler", fastify.authenticate);
  fastify.addHook("preHandler", fastify.isAdmin);

  // GET /users - List all users
  fastify.get("/users", async (request, reply) => {
    try {
      const users = await prisma.user.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          _count: {
            select: { invoices: true, clients: true },
          },
          subscriptions: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { status: true, subscriptionEnds: true },
          },
        },
      });
      return users;
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to fetch users");
    }
  });

  // GET /stats - System-wide stats
  fastify.get("/stats", async (request, reply) => {
    try {
      const [userCount, invoiceCount, totalRevenueRaw] = await Promise.all([
        prisma.user.count(),
        prisma.invoice.count(),
        prisma.invoice.aggregate({
          where: { status: "Paid" },
          _sum: { amount: true },
        }),
      ]);

      return {
        totalUsers: userCount,
        totalInvoices: invoiceCount,
        totalRevenue: totalRevenueRaw._sum.amount || 0,
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to fetch system stats");
    }
  });

  // PATCH /users/:id - Update user status or plan
  fastify.patch("/users/:id", async (request, reply) => {
    try {
      const { id } = request.params;
      const { plan, role, isActive, subscriptionEnds } = request.body;

      if (subscriptionEnds !== undefined) {
        // Update their latest subscription if they have one
        const latestSub = await prisma.subscription.findFirst({
          where: { userId: parseInt(id) },
          orderBy: { createdAt: "desc" },
        });
        if (latestSub) {
          await prisma.subscription.update({
            where: { id: latestSub.id },
            data: {
              subscriptionEnds: subscriptionEnds
                ? new Date(subscriptionEnds)
                : null,
              status: "ACTIVE",
            },
          });
        }
      }

      const updatedUser = await prisma.user.update({
        where: { id: parseInt(id) },
        data: {
          ...(plan && { plan }),
          ...(role && { role }),
          ...(isActive !== undefined && { isActive }),
        },
      });

      return updatedUser;
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to update user");
    }
  });

  // POST /users/:id/cancel-subscription - Administrative cancel
  fastify.post("/users/:id/cancel-subscription", async (request, reply) => {
    try {
      const { id } = request.params;
      const userId = parseInt(id);

      const { cancelRecurringPlan } = require("../../utils/xendit");

      // 1. Find active subscription
      const activeSub = await prisma.subscription.findFirst({
        where: { userId, status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
      });

      if (activeSub && activeSub.xenditSubscriptionId) {
        // Cancel in Xendit
        await cancelRecurringPlan(activeSub.xenditSubscriptionId);

        await prisma.subscription.update({
          where: { id: activeSub.id },
          data: { status: "CANCELLED" },
        });
      }

      // 2. Downgrade user
      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: {
          plan: "FREE",
          xenditSubscriptionId: null,
        },
      });

      return updatedUser;
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to cancel subscription");
    }
  });

  // DELETE /users/:id - Delete user
  fastify.delete("/users/:id", async (request, reply) => {
    try {
      const { id } = request.params;
      await prisma.user.delete({
        where: { id: parseInt(id) },
      });

      return { success: true, message: "User deleted successfully" };
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to delete user");
    }
  });
  // Register promo code routes
  fastify.register(require("./promo-codes"), { prefix: "/promo-codes" });
  // Register transaction routes
  fastify.register(require("./transactions"), { prefix: "/transactions" });
}

module.exports = adminRoutes;
