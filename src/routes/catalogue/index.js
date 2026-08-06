/**
 * CATALOGUE — the things you sell, priced once.
 *
 * Everything here is a convenience for filling in a line item. Nothing here is
 * authoritative about an invoice: a line item copies name, price and unit at the
 * moment it is added and never looks back. Raising your day rate changes what
 * the next invoice starts as, not what last quarter's invoices say.
 *
 * That is also why there is no delete that takes items off old documents. The
 * destructive action is `archived`, which hides an item from the picker and the
 * default list while leaving every invoice that used it untouched. A real
 * DELETE exists for something typed by mistake ten seconds ago.
 */

const SORTS = {
  /* Most-used first is the useful default. A catalogue is a long tail with four
     or five items doing nearly all the work, and alphabetical buries them. */
  used: [{ timesUsed: "desc" }, { name: "asc" }],
  name: [{ name: "asc" }],
  price: [{ price: "desc" }],
  recent: [{ createdAt: "desc" }],
};

async function catalogueRoutes(fastify, opts) {
  const { prisma } = fastify;

  fastify.register(async function (protectedInstance) {
    protectedInstance.addHook("onRequest", fastify.authenticate);

    protectedInstance.get("/", async (request) => {
      const { includeArchived, sort } = request.query || {};
      return prisma.catalogueItem.findMany({
        where: {
          userId: request.user.id,
          ...(includeArchived === "true" ? {} : { archived: false }),
        },
        orderBy: SORTS[sort] || SORTS.used,
      });
    });

    protectedInstance.get("/:id", async (request, reply) => {
      const item = await prisma.catalogueItem.findFirst({
        where: { id: Number(request.params.id), userId: request.user.id },
      });
      if (!item) return reply.notFound("Item not found");
      return item;
    });

    const bodySchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: ["string", "null"] },
        price: { type: "number" },
        unit: { type: ["string", "null"] },
        archived: { type: "boolean" },
      },
    };

    protectedInstance.post(
      "/",
      { schema: { body: { ...bodySchema, required: ["name"] } } },
      async (request, reply) => {
        const { name, description, price, unit } = request.body;
        if (!String(name).trim()) return reply.badRequest("Give the item a name.");

        /* Not a database constraint. A unique index would also block reusing the
           name of something you archived years ago, which is a normal thing to
           want to do. Checking only among the live ones says what we actually
           mean: you cannot have two of these in the picker at once. */
        const clash = await prisma.catalogueItem.findFirst({
          where: {
            userId: request.user.id,
            archived: false,
            name: { equals: String(name).trim(), mode: "insensitive" },
          },
          select: { id: true },
        });
        if (clash) {
          return reply.conflict(`You already have "${String(name).trim()}" in your catalogue.`);
        }

        return prisma.catalogueItem.create({
          data: {
            userId: request.user.id,
            name: String(name).trim(),
            description: description?.trim() || null,
            price: Number(price) || 0,
            unit: unit?.trim() || null,
          },
        });
      },
    );

    protectedInstance.put("/:id", { schema: { body: bodySchema } }, async (request, reply) => {
      const id = Number(request.params.id);
      const existing = await prisma.catalogueItem.findFirst({
        where: { id, userId: request.user.id },
        select: { id: true },
      });
      if (!existing) return reply.notFound("Item not found");

      const { name, description, price, unit, archived } = request.body;
      return prisma.catalogueItem.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name: String(name).trim() } : {}),
          ...(description !== undefined ? { description: description?.trim() || null } : {}),
          ...(price !== undefined ? { price: Number(price) || 0 } : {}),
          ...(unit !== undefined ? { unit: unit?.trim() || null } : {}),
          ...(archived !== undefined ? { archived: !!archived } : {}),
        },
      });
    });

    protectedInstance.delete("/:id", async (request, reply) => {
      const id = Number(request.params.id);
      const existing = await prisma.catalogueItem.findFirst({
        where: { id, userId: request.user.id },
        select: { id: true, timesUsed: true, name: true },
      });
      if (!existing) return reply.notFound("Item not found");

      /* Something used on a real document gets archived instead, whatever the
         caller asked for. Deleting it does not change those documents — they
         carry their own copy — but the user is about to lose the only record of
         what they charge for this, and "it is on 40 invoices" is worth saying. */
      if (existing.timesUsed > 0) {
        await prisma.catalogueItem.update({ where: { id }, data: { archived: true } });
        return {
          archived: true,
          message: `"${existing.name}" has been used on documents, so it is archived rather than deleted.`,
        };
      }

      await prisma.catalogueItem.delete({ where: { id } });
      return { archived: false, message: "Item deleted" };
    });

    /**
     * Record that items were pulled onto a document.
     *
     * Fire-and-forget from the builder's point of view — the counter drives sort
     * order and nothing else, so a failure here must never cost somebody their
     * invoice. The route is idempotent-ish by design: it counts uses, not items,
     * and nothing downstream reads it for correctness.
     */
    protectedInstance.post("/used", async (request) => {
      const ids = (request.body?.ids || [])
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0);
      if (!ids.length) return { counted: 0 };

      const { count } = await prisma.catalogueItem.updateMany({
        where: { id: { in: ids }, userId: request.user.id },
        data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() },
      });
      return { counted: count };
    });
  });
}

module.exports = catalogueRoutes;
