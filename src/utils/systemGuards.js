/**
 * Server-side enforcement for the admin kill switches.
 *
 * `invoiceCreationEnabled` was being read in exactly two places before this: the
 * admin screen that sets it, and the defaults used when the config row is first
 * created. No write path checked it. The switch hid buttons in the frontend and
 * redirected /invoices/create — and that is all it did, so a POST straight to
 * the API created an invoice with the switch off.
 *
 * That matters because of what the switch is for. An admin turns it off during
 * an incident or a migration and believes creation has stopped; meanwhile
 * anything holding a session — a retrying client, a script, a stale tab —
 * carries on writing rows.
 */

/**
 * Throws a 403-shaped error when document creation is switched off platform-wide.
 * Missing config is treated as enabled, matching the defaults used everywhere
 * else: a first-run install with no SystemConfiguration row should work.
 */
async function assertCreationEnabled(prisma, reply, noun = "Invoices") {
  const config = await prisma.systemConfiguration.findFirst({
    select: { invoiceCreationEnabled: true },
  });
  if (config && config.invoiceCreationEnabled === false) {
    reply.forbidden(
      `${noun} are temporarily switched off while we carry out maintenance. Nothing you have already sent is affected.`,
    );
    return false;
  }
  return true;
}

/**
 * Throws a 403-shaped error when moving onto a paid plan is switched off
 * platform-wide.
 *
 * FREE is always allowed through. The switch stops new commitments; it is not a
 * lock on the door. Somebody on Pro who wants to cancel down to Free must still
 * be able to, and /subscribe treats FREE as the cancellation path.
 *
 * Same reasoning as `assertCreationEnabled` above: the frontend hides the
 * upgrade buttons, and that is worth doing, but it is not the enforcement. A
 * checkout can be started from a stale tab, a retry, or a direct POST, and each
 * one that gets through while the switch is off is a real charge on a real card
 * that somebody then has to unwind by hand.
 *
 * Missing config counts as enabled, matching the defaults used everywhere else.
 */
async function assertPlanChangesEnabled(prisma, reply, targetPlan) {
  if (String(targetPlan || "").trim().toUpperCase() === "FREE") return true;

  const config = await prisma.systemConfiguration.findFirst({
    select: { planUpgradesEnabled: true },
  });
  if (config && config.planUpgradesEnabled === false) {
    reply.forbidden(
      "Plan changes are paused at the moment, so nothing has been charged. The Free plan is still available, and any plan you already have keeps running as normal.",
    );
    return false;
  }
  return true;
}

/**
 * Which channels the AUTOMATED chaser may use right now.
 *
 * Not an assert like the two above, because there is no reply to fail: the
 * caller is the cron, and nobody is waiting on a response. It returns a pair of
 * booleans and the cron decides what to do with them.
 *
 * TWO SWITCHES ARE CONSULTED PER CHANNEL, and both have to be on:
 *
 *   * `emailEnabled` / `whatsappEnabled` — the channel itself. If email is down
 *     platform-wide, the chaser must not be the one component still trying to
 *     use it. Nothing checked this before: those switches gated the routes a
 *     user touches, while the cron went on sending unattended, which is the
 *     opposite of the priority an admin has during an outage.
 *   * `autoChaseEmailEnabled` / `autoChaseWaEnabled` — the chaser alone, for
 *     when the channel is healthy and it is the automation that has gone wrong.
 *
 * Reads through the 60s config cache, so a sweep does not add a query per user,
 * and an admin flipping a switch has it apply on the next run rather than after
 * a deploy.
 *
 * Missing config counts as enabled, matching every other default here.
 */
async function autoChaseChannels(fastify) {
  const cfg = (await fastify.getSystemConfig()) || {};
  return {
    email: cfg.emailEnabled !== false && cfg.autoChaseEmailEnabled !== false,
    whatsapp: cfg.whatsappEnabled !== false && cfg.autoChaseWaEnabled !== false,
  };
}

module.exports = {
  assertCreationEnabled,
  assertPlanChangesEnabled,
  autoChaseChannels,
};
