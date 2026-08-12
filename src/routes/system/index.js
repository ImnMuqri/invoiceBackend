/**
 * The platform switches, readable by any signed-in account.
 *
 * WHY THIS EXISTS. Before it, the only way to read a kill switch was
 * GET /api/admin/system — admin-only — or whatever page happened to embed
 * `system` in its own payload (the dashboard, an invoice, the public pay page).
 * So a screen that needed a switch and had no payload of its own could not see
 * one: `layouts/default.vue` has been calling `systemStore.fetchPublicConfig()`
 * inside an empty catch since before this, against a store action that does not
 * exist, and swallowing the TypeError every time. Onboarding, which runs with no
 * layout at all, had nowhere to ask.
 *
 * Authenticated rather than open: `globalNotice` is written for the people using
 * the product and can name an ongoing incident in as much detail as an admin
 * cares to give, which is not something to hand to anyone who curls the API.
 * Everything returned here is already shown to the user in the UI.
 *
 * Reads through `getSystemConfig`, so it shares the 60s cache with every other
 * consumer and an admin flipping a switch invalidates this too.
 */
async function systemRoutes(fastify, opts) {
  fastify.addHook("preHandler", fastify.authenticate);

  fastify.get("/", async (request, reply) => {
    try {
      const cfg = await fastify.getSystemConfig();

      /* Named explicitly rather than spread. The row gains columns over time and
         a spread would publish each new one the moment it is added, which is the
         wrong default for a table that holds operational state. */
      return {
        whatsappEnabled: cfg.whatsappEnabled,
        emailEnabled: cfg.emailEnabled,
        invoiceCreationEnabled: cfg.invoiceCreationEnabled,
        paymentsEnabled: cfg.paymentsEnabled,
        planUpgradesEnabled: cfg.planUpgradesEnabled,
        globalNotice: cfg.globalNotice,
        maintenanceMode: cfg.maintenanceMode,
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to read system configuration");
    }
  });
}

module.exports = systemRoutes;
