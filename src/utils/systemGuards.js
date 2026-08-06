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

module.exports = { assertCreationEnabled };
