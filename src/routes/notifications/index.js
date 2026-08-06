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

    /* DELETE one.
       deleteMany rather than delete, scoped by userId: a plain delete on an id
       that is not yours throws a record-not-found the caller can tell apart from
       a successful one, which turns this into a way to probe for other people's
       notification ids. This returns the same shape either way. */
    protectedInstance.delete("/:id", async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return reply.badRequest("Bad notification id");

      const result = await prisma.appNotification.deleteMany({
        where: { id, userId: request.user.id },
      });
      if (!result.count) return reply.notFound("Notification not found");
      return { success: true, count: result.count };
    });

    /* DELETE many.
       ?scope=read clears only what has been read, which is the safe sweep and
       the one the UI offers by default. scope=all is the deliberate one. */
    protectedInstance.delete("/", async (request, reply) => {
      const scope = request.query?.scope === "all" ? "all" : "read";
      const result = await prisma.appNotification.deleteMany({
        where: {
          userId: request.user.id,
          ...(scope === "read" ? { isRead: true } : {}),
        },
      });
      return { success: true, count: result.count, scope };
    });
  });
}

module.exports = notificationRoutes;
