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
