/**
 * Usage, for the dashboard panel (spec 01).
 *
 * Shown before the limit is hit, not after. A user who discovers their
 * allowance by having a reminder silently downgraded has already had the bad
 * experience the panel exists to prevent.
 */
async function usageRoutes(fastify, opts) {
  fastify.register(async function (protectedInstance) {
    protectedInstance.addHook("onRequest", fastify.authenticate);

    protectedInstance.get("/", async (request, reply) => {
      const summary = await fastify.chase.usageSummary(request.user.id);
      if (!summary) return reply.notFound("No usage for this account");
      return summary;
    });
  });
}

module.exports = usageRoutes;
