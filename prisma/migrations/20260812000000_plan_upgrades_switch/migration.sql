-- Platform switch: can anyone move onto a paid plan?
--
-- The fifth kill switch, alongside invoice creation, email, WhatsApp and
-- payments. Off means Free is the only plan anybody can select — in onboarding
-- and in Settings → Billing — and POST /api/users/subscribe refuses any target
-- other than FREE. It exists for the periods when taking money is the one thing
-- the platform must not do: a gateway migration, a pricing change mid-flight, a
-- billing incident where every new subscription is another thing to unwind.
--
-- DELIBERATELY NOT AFFECTED, because the switch is about new commitments rather
-- than about punishing customers:
--
--   * Existing paid plans keep running and keep renewing. Nobody is downgraded,
--     and no subscription is cancelled by flipping this.
--   * Cancelling down to Free stays available. Blocking someone from leaving a
--     paid plan is the opposite of what an incident switch is for.
--   * Top-ups are a separate, one-off purchase and have their own path; they are
--     untouched here.
--
-- Defaults to true, so every existing install and every fresh one keeps selling
-- plans until an admin decides otherwise.

ALTER TABLE "SystemConfiguration"
  ADD COLUMN IF NOT EXISTS "planUpgradesEnabled" BOOLEAN NOT NULL DEFAULT true;
