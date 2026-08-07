-- Plan revision: retire Starter, reprice PRO and MAX, and make the Plan table
-- the single source of truth for what a plan allows.
--
-- ORDER MATTERS. Enforcement moves from a hardcoded object to this table in the
-- same release, so the table has to be correct and complete BEFORE that lands:
--   * `quotes` was 0 on every row (the column was added with a default and never
--     seeded), so switching enforcement first would have taken every customer's
--     quotation allowance to zero.
--   * Plan names and User.plan were inconsistently cased — the live data held
--     both 'Starter' and 'STARTER', and an exact-match lookup silently fell back
--     to FREE for one of them.

-- 1. One casing everywhere. Do this before anything matches on a name.
UPDATE "Plan" SET "name" = UPPER("name");
UPDATE "User" SET "plan" = UPPER("plan") WHERE "plan" IS NOT NULL;
UPDATE "Subscription" SET "plan" = UPPER("plan") WHERE "plan" IS NOT NULL;

-- 2. Seed the quotation allowance. Mirrors the invoice allowance, which is the
--    defensible default: a quotation costs the same to produce as an invoice.
--    Adjustable from the admin panel afterwards like every other limit.
UPDATE "Plan" SET "quotes" = "invoices" WHERE "quotes" = 0;

-- 3. Retire Starter. Deactivated rather than deleted: Subscription rows record
--    the plan by name, and deleting it would orphan the billing history of
--    anyone who was ever on it. GET /plans already filters isActive, so it stops
--    appearing on the pricing page and in the admin plan picker.
UPDATE "Plan" SET "isActive" = false WHERE "name" = 'STARTER';

-- 4. Move anyone on Starter to PRO.
--    Note this is a PRICE RISE for them: Starter was RM19, PRO is RM29. Their
--    limits go up substantially in exchange (20 invoices to 100, 10 WhatsApp
--    sends to 50, and auto-chasing they did not have at all), but it is still a
--    rise, and the recurring plan in Xendit is keyed to the old amount. If any
--    of these were real paying customers rather than test accounts, they need
--    telling before this runs, and their subscription re-created at the new
--    price — this UPDATE changes what they are entitled to, not what Xendit
--    bills them.
UPDATE "User" SET "plan" = 'PRO' WHERE "plan" = 'STARTER';
UPDATE "Subscription" SET "plan" = 'PRO' WHERE "plan" = 'STARTER' AND "status" = 'ACTIVE';

-- 5. New pricing.
UPDATE "Plan" SET "price" = 29 WHERE "name" = 'PRO';
UPDATE "Plan" SET "price" = 49 WHERE "name" = 'MAX';
