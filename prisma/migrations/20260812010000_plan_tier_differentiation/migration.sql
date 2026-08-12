-- Pro and Max stop differing on volume alone, and the feature bullets catch up
-- with what is actually enforced.
--
-- TWO SEPARATE PROBLEMS, one migration, because shipping either half alone
-- leaves the pricing card lying in a different direction than it does now.
--
-- 1. `Plan.features` is free text and nothing has ever written it but the seed
--    script. The metering migration (20260807150000) moved paid plans to
--    unlimited invoices, email and AI, and never touched the bullets — so the
--    Pro card has been advertising "100 Invoices/mo", "20 AI Drafts/mo" and a
--    "50 WhatsApp Sends & Reminders" cap that no longer exists in code at all,
--    while saying nothing about the 25 chased invoices that are the only thing
--    which actually runs out. Every line on that card was wrong except
--    Auto-Chaser.
--
-- 2. Spec 01 said Pro and Max differ on volume only. That is reversed here, on
--    purpose: unlimited AI drafts and removing "Sent with InvoKita" become Max
--    features, because a volume-only ladder gave a prospect nothing concrete to
--    weigh, and these are the two differences a reader understands without
--    reading a table. See the note in utils/attribution.js.

-- ── Pro gets a real AI ceiling ─────────────────────────────────────────────
-- 50/month, not the old 20. High enough that a working freelancer drafting
-- every invoice never meets it, so the cap reads as a fair-use line rather than
-- as the feature being withheld — while leaving "unlimited" a true statement
-- about Max. Max stays at the 999999 sentinel.
UPDATE "Plan" SET "aiCredits" = 50 WHERE "name" = 'PRO';
UPDATE "Plan" SET "aiCredits" = 999999 WHERE "name" = 'MAX';

-- ── Attribution becomes a Max feature ──────────────────────────────────────
-- The rule itself lives in utils/attribution.js and ignores this column for Pro
-- from now on, so this UPDATE changes nothing a client would see. It exists so
-- the SWITCH is not left sitting in a position the plan no longer honours: a
-- Pro account that had turned attribution off would otherwise open Business →
-- Documents and see the control reading "off" while the footer prints on every
-- invoice. Better a control that tells the truth than a stored preference for
-- an entitlement the account does not have.
UPDATE "UserInvoiceConfig" SET "attributionEnabled" = true
WHERE "attributionEnabled" = false
  AND "userId" IN (SELECT "id" FROM "User" WHERE UPPER("plan") IN ('FREE', 'PRO'));

-- ── The bullets ────────────────────────────────────────────────────────────
-- Chased invoices lead on every paid plan, because that is the metered unit and
-- the number a user needs in order to predict when the product stops working.
-- The WhatsApp send count is gone entirely: nothing has incremented waSends or
-- waReminders since spec 01, so listing it advertised a cap that is not real and
-- buried the one that is.
-- Free deliberately does NOT say "chased invoices". The cron only processes PRO
-- and MAX, so nothing on Free is ever chased automatically — the one-time grant
-- is spent by pressing send yourself, and the landing page strips any bullet
-- matching /chas/i from a plan without the chaser precisely so a free tier
-- cannot appear to promise automation it will never get.
UPDATE "Plan" SET "features" = ARRAY[
  '5 Invoices/mo',
  '5 Email Deliveries/mo',
  '2 AI Drafts/mo',
  '3 WhatsApp sends to try it out'
] WHERE "name" = 'FREE';

UPDATE "Plan" SET "features" = ARRAY[
  '25 Chased Invoices/mo',
  'Unlimited Invoices & Quotations',
  'Unlimited Email Deliveries & Reminders',
  '50 AI Drafts/mo',
  'Auto-Chaser'
] WHERE "name" = 'PRO';

UPDATE "Plan" SET "features" = ARRAY[
  '75 Chased Invoices/mo',
  'Unlimited Invoices & Quotations',
  'Unlimited Email Deliveries & Reminders',
  'Unlimited AI Drafts',
  'Auto-Chaser',
  'Remove "Sent with InvoKita"'
] WHERE "name" = 'MAX';
