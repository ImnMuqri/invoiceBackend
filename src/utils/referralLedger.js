/**
 * Granting and reversing referral credit (spec 09, part B).
 *
 * Split from utils/referral.js on purpose: that file is pure arithmetic and
 * rules, testable without a database. This one writes. Keeping the decisions
 * where they can be tested and the writes where they can be audited is what
 * makes the reward mechanics reviewable at all.
 *
 * Both functions are IDEMPOTENT, which matters more here than almost anywhere
 * else in the codebase: payment webhooks are delivered more than once as a
 * matter of routine, and a grant that ran twice is money given away twice.
 * Idempotency is enforced by the ledger row's status, in the WHERE clause of a
 * conditional update — never by reading first and writing after.
 */

const {
  STATUS,
  periodKey,
  creditForConversion,
  CREDIT_SEN,
  REFERRED_DISCOUNT_SEN,
} = require("./referral");

/**
 * The referred account has paid for the first time. Grant the credit.
 *
 * Safe to call on every payment event for any account: it does nothing unless
 * there is a PENDING referral naming this user as the referred party, and the
 * conditional update means only the first of N concurrent webhook deliveries
 * can move it out of PENDING.
 */
async function convertReferral(fastify, prisma, referredUserId) {
  try {
    const referral = await prisma.referral.findUnique({
      where: { referredId: referredUserId },
      select: { id: true, referrerId: true, status: true },
    });

    /* No referral, or one that already paid, or one rejected at signup for
       failing an anti-abuse check. All three are "nothing to do". */
    if (!referral || referral.status !== STATUS.PENDING) return null;

    const period = periodKey();

    /* What has already been earned this period, for the cap. Reversed
       referrals are excluded: a reversal means the money was taken back, and
       the allowance it consumed goes back with it. */
    const earned = await prisma.referral.aggregate({
      where: {
        referrerId: referral.referrerId,
        status: STATUS.CONVERTED,
        creditPeriod: period,
      },
      _sum: { creditSen: true },
    });

    const creditSen = creditForConversion(earned._sum.creditSen || 0);

    /* The cap is reached. The referral still CONVERTS — it happened, and the
       referrer should see it on their page — it is simply worth nothing this
       period. Recording it as converted-for-zero is more honest than leaving
       it pending forever, which would look like the referral never landed. */
    const { count } = await prisma.referral.updateMany({
      where: { id: referral.id, status: STATUS.PENDING },
      data: {
        status: STATUS.CONVERTED,
        creditSen,
        discountSen: REFERRED_DISCOUNT_SEN,
        creditPeriod: period,
        convertedAt: new Date(),
      },
    });

    /* Lost the race to a duplicate webhook delivery. The other one granted it. */
    if (count === 0) return null;

    if (creditSen > 0) {
      await prisma.user.update({
        where: { id: referral.referrerId },
        data: { referralCreditSen: { increment: creditSen } },
      });
    }

    try {
      const { createNotification } = require("./notificationUtils");
      await createNotification(
        prisma,
        referral.referrerId,
        creditSen > 0 ? "Referral credit earned" : "A referral converted",
        creditSen > 0
          ? `Someone you referred just subscribed. RM${(creditSen / 100).toFixed(2)} has been credited against your next payment.`
          : "Someone you referred just subscribed. You have reached this month's credit cap, so this one earns nothing — it still counts.",
        "REFERRAL",
      );
    } catch (err) {
      fastify.log.warn({ err }, "Referral notification failed");
    }

    fastify.log.info(
      { referralId: referral.id, referrerId: referral.referrerId, creditSen, period },
      "Referral converted",
    );
    return { referralId: referral.id, creditSen };
  } catch (err) {
    /* Never throw into a webhook. Xendit retries on a non-2xx, and a retry
       loop caused by a referral bookkeeping error would put the SUBSCRIPTION
       itself at risk — which is a far worse outcome than a missing credit. */
    fastify.log.error({ err, referredUserId }, "Referral conversion failed");
    return null;
  }
}

/**
 * The referred account's payment was refunded or charged back. Take it back.
 *
 * The spec requires this and it is the reason the ledger exists at all: an
 * integer counter can record that a reward happened but not which one, so it
 * cannot be reversed.
 *
 * Floors at zero rather than allowing a negative balance. Somebody whose
 * referral charged back should not end up owing us money on an account they
 * did not misuse — the worst outcome for us is that the credit was already
 * spent, which is a cost of doing business and not something to claw out of an
 * innocent user's next invoice.
 */
async function reverseReferral(fastify, prisma, referredUserId, reason = "refund") {
  try {
    const referral = await prisma.referral.findUnique({
      where: { referredId: referredUserId },
      select: { id: true, referrerId: true, status: true, creditSen: true },
    });

    if (!referral || referral.status !== STATUS.CONVERTED) return null;

    const { count } = await prisma.referral.updateMany({
      where: { id: referral.id, status: STATUS.CONVERTED },
      data: {
        status: STATUS.REVERSED,
        reversedAt: new Date(),
        rejectedReason: reason,
        /* creditSen is deliberately NOT zeroed. It records what was granted;
           `status` records that it no longer counts. Erasing the amount would
           destroy the only evidence of how much to take back. */
      },
    });

    if (count === 0) return null;

    if (referral.creditSen > 0) {
      /* Two steps rather than a decrement, because a decrement can go negative
         and Prisma has no "decrement, floored at zero". Read then write is
         acceptable here where it was not for the grant: the worst a race can
         do is leave a few sen of credit behind, whereas a double GRANT is
         money out the door. */
      const referrer = await prisma.user.findUnique({
        where: { id: referral.referrerId },
        select: { referralCreditSen: true },
      });
      const next = Math.max(0, (referrer?.referralCreditSen || 0) - referral.creditSen);
      await prisma.user.update({
        where: { id: referral.referrerId },
        data: { referralCreditSen: next },
      });
    }

    fastify.log.warn(
      { referralId: referral.id, referrerId: referral.referrerId, reason },
      "Referral credit reversed",
    );
    return { referralId: referral.id, reversedSen: referral.creditSen };
  } catch (err) {
    fastify.log.error({ err, referredUserId }, "Referral reversal failed");
    return null;
  }
}

module.exports = { convertReferral, reverseReferral, CREDIT_SEN };
