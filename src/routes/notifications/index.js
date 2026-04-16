async function notificationRoutes(fastify, opts) {
  const { prisma } = fastify;

  fastify.register(async function (protectedInstance) {
    protectedInstance.addHook("onRequest", fastify.authenticate);

    // GET all notifications for the current user
    protectedInstance.get("/", async (request, reply) => {
      const take = Number(request.query.limit) || 50;
      return prisma.appNotification.findMany({
        where: { userId: request.user.id },
        orderBy: { createdAt: "desc" },
        take,
      });
    });

    // GET unread notifications count
    protectedInstance.get("/unread-count", async (request, reply) => {
      const count = await prisma.appNotification.count({
        where: { userId: request.user.id, isRead: false },
      });
      return { count };
    });

    // PUT mark a string notification as read
    protectedInstance.put("/:id/read", async (request, reply) => {
      const id = Number(request.params.id);
      const notification = await prisma.appNotification.updateMany({
        where: { id, userId: request.user.id },
        data: { isRead: true },
      });
      return { success: true, count: notification.count };
    });

    // PUT mark all notifications as read
    protectedInstance.put("/read-all", async (request, reply) => {
      const result = await prisma.appNotification.updateMany({
        where: { userId: request.user.id, isRead: false },
        data: { isRead: true },
      });
      return { success: true, count: result.count };
    });
  });
}

module.exports = notificationRoutes;
