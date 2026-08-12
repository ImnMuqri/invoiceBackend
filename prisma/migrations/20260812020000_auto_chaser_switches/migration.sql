-- Platform switches: can the AUTOMATED chaser send, per channel?
--
-- The sixth and seventh kill switches. They are narrower than the ones already
-- here and that is the point — `emailEnabled` and `whatsappEnabled` stop a whole
-- channel, including the invoice a user is trying to send by hand right now.
-- These two stop only the cron, which is the part that fires unattended, at 9am,
-- to somebody else's client, with nobody watching.
--
-- That is the failure worth having a switch for. A template gets rejected, a
-- provider starts bouncing, a timezone bug sends at 3am, a message renders with
-- {{clientName}} unsubstituted — every one of those keeps happening on a
-- schedule until someone stops it, and the alternative to a switch is
-- redeploying with the cron commented out.
--
-- WHATSAPP OFF DOES NOT MEAN SILENCE. A scheduled WhatsApp chase downgrades to
-- email, exactly as it does when the account is out of allowance, and for the
-- reason spec 01 gives: an invoice chased twice and then abandoned is worse than
-- one never chased, because the user blames us for the unpaid invoice. An admin
-- who wants nothing sent at all switches both off — which is a decision worth
-- having to make deliberately rather than one that falls out of a single click.
--
-- Both default true, so every existing install keeps chasing until an admin
-- decides otherwise.

ALTER TABLE "SystemConfiguration"
  ADD COLUMN IF NOT EXISTS "autoChaseEmailEnabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "SystemConfiguration"
  ADD COLUMN IF NOT EXISTS "autoChaseWaEnabled" BOOLEAN NOT NULL DEFAULT true;
