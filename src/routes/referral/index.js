/**
 * The referral programme (spec 09, part B).
 *
 * MIXED AUTH, and the split is deliberate. The click tracker is PUBLIC — it is
 * hit by somebody who has just followed a link and has no account yet, which is
 * the entire point of the link. Everything else is the account owner's own data
 * and is authenticated. The public route is registered outside the protected
 * sub-plugin rather than by disabling a hook, so nothing can drift across the
 * boundary by accident.
 *
 * The reward mechanics live in utils/referral.js. This file is the plumbing.
 */

const {
  STATUS,
  periodKey,
  visitorHash,
  referralUrl,
  shareText,
  CREDIT_SEN,
  REFERRED_DISCOUNT_SEN,
  PERIOD_CAP_SEN,
  ATTRIBUTION_WINDOW_DAYS,
  shouldSharePrompt,
} = require("../../utils/referral");

async function referralRoutes(fastify, opts) {
  const { prisma } = fastify;

  /* ─── PUBLIC ─────────────────────────────────────────────────────────────
     One route, no session, and it must stay that way. */

  /**
   * POST /api/referral/click
   *
   * Records that a referral link was opened. Called by the frontend's /r page
   * before it forwards the visitor to the signup form.
   *
   * Answers 204 whatever happens, including for a code that does not exist.
   * Two reasons: a broken link should still take somebody to the signup page
   * rather than showing them an error about somebody else's referral code, and
   * a differing response would turn this into an oracle for guessing which
   * codes are real.
   */
  fastify.post(
    "/click",
    {
      schema: {
        body: {
          type: "object",
          required: ["code"],
          additionalProperties: false,
          properties: {
            code: { type: "string", maxLength: 32 },
            via: { type: "string", maxLength: 16 },
          },
        },
      },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const code = String(request.body.code || "").trim().toUpperCase();

      try {
        const referrer = await prisma.user.findUnique({
          where: { referralCode: code },
          select: { id: true },
        });

        if (referrer) {
          const hash = visitorHash(
            request.ip,
            request.headers["user-agent"] || "",
          );

          /* Deduped to one click per visitor per day. Without it the number on
             the referrals page counts refreshes, and a stat that inflates
             itself is worse than no stat — the user reads "40 clicks, 0
             signups" and concludes the product is unsellable when really four
             people looked at it. */
          const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
          const already = await prisma.referralClick.findFirst({
            where: { referrerId: referrer.id, visitorHash: hash, createdAt: { gte: since } },
            select: { id: true },
          });

          if (!already) {
            await prisma.referralClick.create({
              data: {
                referrerId: referrer.id,
                visitorHash: hash,
                source: request.body.via ? String(request.body.via).slice(0, 16) : null,
              },
            });
          }
        }
      } catch (err) {
        /* Never fail the visitor's journey over a statistic. */
        fastify.log.warn({ err }, "Referral click could not be recorded");
      }

      return reply.code(204).send();
    },
  );

  /* ─── AUTHENTICATED ──────────────────────────────────────────────────── */
  fastify.register(async function (protectedInstance) {
    protectedInstance.addHook("onRequest", fastify.authenticate);

    /** Mint a code for an account that predates the programme. */
    const ensureCode = async (userId, existing) => {
      if (existing) return existing;
      const crypto = require("crypto");
      const code = crypto.randomBytes(4).toString("hex").toUpperCase();
      await prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
      return code;
    };

    /**
     * GET /api/referral/stats
     *
     * Everything the referrals page shows: the link, clicks, signups,
     * conversions and credit earned.
     *
     * The four numbers are deliberately separate rather than one "referrals"
     * count. Clicks-without-signups and signups-without-conversions are
     * different problems with different fixes, and a single number hides which
     * one somebody has.
     */
    protectedInstance.get("/stats", async (request) => {
      const userId = request.user.id;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          referralCode: true,
          referralCreditSen: true,
          /* The legacy count. Still shown while anybody still holds one, so
             nothing anybody earned quietly disappears. */
          referralCredits: true,
        },
      });

      const code = await ensureCode(userId, user?.referralCode);
      const period = periodKey();

      const [clicks, referrals, periodCredit] = await Promise.all([
        prisma.referralClick.count({ where: { referrerId: userId } }),
        prisma.referral.findMany({
          where: { referrerId: userId },
          orderBy: { signedUpAt: "desc" },
          take: 50,
          select: {
            id: true,
            status: true,
            creditSen: true,
            signedUpAt: true,
            convertedAt: true,
            /* The referred person's NAME is not returned, and their email is
               masked. The referrer is owed proof their referral worked, not a
               view into somebody else's account. */
            referred: { select: { email: true, createdAt: true } },
          },
        }),
        prisma.referral.aggregate({
          where: { referrerId: userId, status: STATUS.CONVERTED, creditPeriod: period },
          _sum: { creditSen: true },
        }),
      ]);

      const mask = (email) => {
        const raw = String(email || "");
        const at = raw.indexOf("@");
        if (at < 1) return "—";
        const head = raw.slice(0, 1);
        return `${head}${"•".repeat(Math.max(2, Math.min(6, at - 1)))}${raw.slice(at)}`;
      };

      const signups = referrals.filter((r) => r.status !== STATUS.REJECTED).length;
      const converted = referrals.filter((r) => r.status === STATUS.CONVERTED).length;

      const earnedThisPeriod = periodCredit._sum.creditSen || 0;

      return {
        code,
        url: referralUrl(code),
        share: { en: shareText(code, "en"), ms: shareText(code, "ms") },

        clicks,
        signups,
        converted,
        /* Sen, like every money value in this codebase. */
        creditSen: user?.referralCreditSen || 0,

        terms: {
          creditSen: CREDIT_SEN,
          referredDiscountSen: REFERRED_DISCOUNT_SEN,
          periodCapSen: PERIOD_CAP_SEN,
          attributionWindowDays: ATTRIBUTION_WINDOW_DAYS,
          earnedThisPeriodSen: earnedThisPeriod,
          remainingThisPeriodSen: Math.max(0, PERIOD_CAP_SEN - earnedThisPeriod),
          period,
        },

        /* Kept for anybody still holding the old count-based credits. */
        legacyCredits: user?.referralCredits || 0,

        recent: referrals.map((r) => ({
          id: r.id,
          status: r.status,
          creditSen: r.creditSen,
          signedUpAt: r.signedUpAt,
          convertedAt: r.convertedAt,
          who: mask(r.referred?.email),
        })),
      };
    });

    /**
     * GET /api/referral/prompt
     *
     * Should the dashboard ask this account to share, right now?
     *
     * Answered by the server rather than the page, because the rule depends on
     * state the page cannot see — when the last qualifying payment landed, when
     * the prompt was last shown, how many times it has been dismissed — and
     * because a prompt whose frequency cap lives in localStorage resets itself
     * every time somebody opens a different browser.
     */
    protectedInstance.get("/prompt", async (request) => {
      const notif = await prisma.userNotification.findUnique({
        where: { userId: request.user.id },
        select: {
          sharePromptEligibleAt: true,
          sharePromptShownAt: true,
          sharePromptDismissals: true,
        },
      });

      const show = shouldSharePrompt({
        eligibleAt: notif?.sharePromptEligibleAt,
        shownAt: notif?.sharePromptShownAt,
        dismissals: notif?.sharePromptDismissals,
      });

      if (!show) return { show: false };

      const user = await prisma.user.findUnique({
        where: { id: request.user.id },
        select: { referralCode: true },
      });
      const code = await ensureCode(request.user.id, user?.referralCode);

      return {
        show: true,
        code,
        url: referralUrl(code),
        share: { en: shareText(code, "en"), ms: shareText(code, "ms") },
        creditSen: CREDIT_SEN,
        referredDiscountSen: REFERRED_DISCOUNT_SEN,
      };
    });

    /**
     * POST /api/referral/prompt/seen
     *
     * `dismissed` records a no. Anything else records that it was shown and
     * starts the cooldown.
     *
     * The eligibility flag is cleared either way: the moment has been used. It
     * is set again by the next invoice that gets paid after a reminder, which
     * is what keeps this tied to a real event rather than to a timer.
     */
    protectedInstance.post(
      "/prompt/seen",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            properties: { dismissed: { type: "boolean" } },
          },
        },
      },
      async (request) => {
        const dismissed = !!request.body?.dismissed;

        await prisma.userNotification.upsert({
          where: { userId: request.user.id },
          update: {
            sharePromptShownAt: new Date(),
            sharePromptEligibleAt: null,
            ...(dismissed ? { sharePromptDismissals: { increment: 1 } } : {}),
          },
          create: {
            userId: request.user.id,
            sharePromptShownAt: new Date(),
            sharePromptDismissals: dismissed ? 1 : 0,
          },
        });

        return { ok: true };
      },
    );

    /**
     * POST /api/referral/claim — the LEGACY reward.
     *
     * Spends the old count-based credits on a free month. Nothing writes to
     * that counter any more (spec 09 grants money credit instead, which needs
     * no claim step), but anybody who earned some before the change can still
     * spend them. It is deleted when the last balance reaches zero.
     */
    protectedInstance.post("/claim", async (request, reply) => {
      /* rewardType came straight off the request body and was written into
         user.plan unchecked, with `cost = rewardType === "PRO" ? 5 : 10` — so
         any string that was not "PRO" cost 10 credits and became the caller's
         plan. Only real, active, paid plans are claimable, and the price is
         looked up rather than inferred from "not PRO". */
      const REWARD_COST = { PRO: 5, MAX: 10 };

      const wanted = String(request.body?.rewardType || "").toUpperCase();
      const cost = REWARD_COST[wanted];
      if (!cost) {
        return reply.badRequest("That is not a claimable reward.");
      }

      const plans = (await fastify.getPlans()) || [];
      const rewardPlan = plans.find(
        (p) => p.isActive !== false && String(p.name).toUpperCase() === wanted,
      );
      if (!rewardPlan) {
        return reply.badRequest("That plan is not available right now.");
      }
      const rewardType = rewardPlan.name;

      const user = await prisma.user.findUnique({ where: { id: request.user.id } });

      if (!user) return reply.unauthorized();
      if (user.referralCredits < cost) {
        return reply.badRequest("Insufficient referral credits");
      }

      const now = new Date();
      const expiry = new Date();
      expiry.setMonth(expiry.getMonth() + 1);

      await prisma.$transaction([
        prisma.user.update({
          where: { id: user.id },
          data: {
            referralCredits: { decrement: cost },
            plan: rewardType,
          },
        }),
        prisma.subscription.create({
          data: {
            userId: user.id,
            plan: rewardType,
            amount: 0,
            status: "ACTIVE",
            subscriptionStart: now,
            subscriptionEnds: expiry,
          },
        }),
      ]);

      return { message: `Successfully claimed 1 month of ${rewardType}!` };
    });
  });
}

module.exports = referralRoutes;
