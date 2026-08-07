-- The share prompt (spec 09, part B).
--
-- Asking somebody to recommend the product is a favour, and WHEN you ask
-- decides whether it feels like one. The spec names the right moment: just
-- after an invoice is marked paid following a reminder the product sent — the
-- one point at which it has demonstrably done the thing it promises, rather
-- than a random Tuesday.
--
-- Three columns, one per rule:
--
--   sharePromptEligibleAt  a qualifying event happened and has not been used.
--                          Set by markInvoiceAsPaid ONLY when a reminder had
--                          actually gone out — an invoice paid on time before
--                          any chasing is a client being organised, and we did
--                          nothing there worth mentioning.
--   sharePromptShownAt     starts the cooldown. Somebody who gets paid weekly
--                          would otherwise see this every week, which turns a
--                          nice moment into furniture.
--   sharePromptDismissals  two "no"s is an answer; a third ask is nagging.
--
-- Server-side rather than in localStorage on purpose: a frequency cap held in
-- the browser resets itself every time somebody opens a different one, so the
-- user who has said no twice on their laptop gets asked again on their phone.

ALTER TABLE "UserNotification"
  ADD COLUMN "sharePromptEligibleAt" TIMESTAMP(3),
  ADD COLUMN "sharePromptShownAt"    TIMESTAMP(3),
  ADD COLUMN "sharePromptDismissals" INTEGER NOT NULL DEFAULT 0;
