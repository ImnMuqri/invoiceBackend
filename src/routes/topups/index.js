/**
 * Top-ups (spec 01).
 *
 * A one-off purchase of extra chased invoices for the CURRENT period. Consumed
 * only after the plan allowance and any trial grant are spent, and deliberately
 * non-rolling: the balance belongs to the period it was bought for, which is
 * stated at the point of purchase rather than buried.
 *
 * The row is created PENDING and only becomes spendable when the payment
 * webhook confirms it. Granting on intent rather than on settlement would make
 * "click checkout, close the tab" a free top-up.
 */

/* A block, not a per-message price: the metered unit is the chased invoice, so
   the thing sold has to be the same unit the user sees running out. Priced with
   healthy margin over the underlying per-message cost. Kept here rather than in
   the Plan table because it is not a plan attribute — it is a product. */
const BLOCKS = {
  small: { chasedInvoices: 10, price: 15 },
  large: { chasedInvoices: 30, price: 39 },
};

async function topUpRoutes(fastify, opts) {
  const { prisma } = fastify;

  fastify.register(async function (protectedInstance) {
    protectedInstance.addHook("onRequest", fastify.authenticate);

    /** What can be bought, and what is already held. */
    protectedInstance.get("/", async (request) => {
      const periodKey = fastify.chase.periodKey();
      const [balance, history] = await Promise.all([
        fastify.chase.topUpBalance(request.user.id, periodKey),
        prisma.topUp.findMany({
          where: { userId: request.user.id },
          orderBy: { createdAt: "desc" },
          take: 12,
        }),
      ]);
      return {
        periodKey,
        balance,
        blocks: Object.entries(BLOCKS).map(([key, b]) => ({ key, ...b })),
        /* Said plainly, at the point of purchase, per the spec. */
        note: "Top-up balance is used only after your plan allowance, and does not carry into next period.",
        history,
      };
    });

    protectedInstance.post("/", async (request, reply) => {
      const block = BLOCKS[String(request.body?.block || "")];
      if (!block) return reply.badRequest("Unknown top-up block.");

      const periodKey = fastify.chase.periodKey();
      const user = await prisma.user.findUnique({
        where: { id: request.user.id },
        select: { email: true },
      });
      if (!user) return reply.unauthorized();

      const row = await prisma.topUp.create({
        data: {
          userId: request.user.id,
          chasedInvoices: block.chasedInvoices,
          periodKey,
          price: block.price,
          status: "PENDING",
        },
      });

      try {
        const { createOneOffCharge } = require("../../utils/xendit");
        const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3000")
          .replace(/['"]/g, "")
          .replace(/\/$/, "");

        const charge = await createOneOffCharge({
          /* Carries the row id so the webhook can find it without guessing. */
          externalId: `topup_${row.id}_${periodKey}`,
          amount: block.price,
          description: `${block.chasedInvoices} extra chased invoices for ${periodKey}`,
          payerEmail: user.email,
          successUrl: `${frontendUrl}/settings?tab=billing&topup=success`,
          failureUrl: `${frontendUrl}/settings?tab=billing&topup=failed`,
        });

        await prisma.topUp.update({
          where: { id: row.id },
          data: { paymentRef: charge.id },
        });

        return { checkoutUrl: charge.checkoutUrl, topUpId: row.id };
      } catch (err) {
        /* Do not leave a PENDING row behind for a checkout that never existed. */
        await prisma.topUp.delete({ where: { id: row.id } }).catch(() => {});
        request.log.error(err, "Failed to create top-up charge");
        return reply.internalServerError("Could not start that purchase.");
      }
    });
  });
}

module.exports = topUpRoutes;
module.exports.BLOCKS = BLOCKS;
