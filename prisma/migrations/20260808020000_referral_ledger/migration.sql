-- Referral programme (spec 09, part B).
--
-- WHY A LEDGER REPLACES A COUNTER
--
-- The programme already existed as `User.referralCredits`, an integer the
-- subscription webhook incremented. That can record THAT a reward happened and
-- nothing else — not which referral earned it, not when, not whether it still
-- stands. The spec requires three things that all need the history:
--
--   * credit reversed when the referred subscription is refunded
--   * a cap on credit earned per period
--   * a page showing clicks, signups, converted accounts and credit earned
--
-- None of those can be computed from a running total with its history thrown
-- away. So: one Referral row per attributed signup, and clicks in their own
-- table.
--
-- NOTHING IS TAKEN AWAY. `referralCredits` and `referralCreditEarned` are left
-- in place and the old claim endpoint still spends them, so anybody holding a
-- balance keeps it. New rewards are money credit in `referralCreditSen`, which
-- needs no claim step and no payout mechanism — it is a discount applied to a
-- bill we are already sending.
--
-- SEN, like every money value in this codebase. A "credits" integer that meant
-- a count in one place and ringgit in another is how the two got confused in
-- the first place.

ALTER TABLE "User"
  ADD COLUMN "referralCreditSen" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "referredAt"        TIMESTAMP(3);

CREATE TABLE "Referral" (
  "id"             SERIAL       NOT NULL,
  "referrerId"     INTEGER      NOT NULL,
  "referredId"     INTEGER      NOT NULL,
  "status"         TEXT         NOT NULL DEFAULT 'PENDING',
  "rejectedReason" TEXT,
  "creditSen"      INTEGER      NOT NULL DEFAULT 0,
  "discountSen"    INTEGER      NOT NULL DEFAULT 0,
  "creditPeriod"   TEXT,
  "clickedAt"      TIMESTAMP(3),
  "signedUpAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "convertedAt"    TIMESTAMP(3),
  "reversedAt"     TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- An account can be referred once, by one person, forever. This constraint is
-- what makes conversion idempotent at the database level: without it a retried
-- registration could write two ledger rows for one account and the reward would
-- be paid twice.
CREATE UNIQUE INDEX "Referral_referredId_key" ON "Referral"("referredId");
CREATE INDEX "Referral_referrerId_status_idx" ON "Referral"("referrerId", "status");
CREATE INDEX "Referral_referrerId_creditPeriod_idx" ON "Referral"("referrerId", "creditPeriod");

CREATE TABLE "ReferralClick" (
  "id"          SERIAL       NOT NULL,
  "referrerId"  INTEGER      NOT NULL,
  -- A salted hash of IP + user agent, never the raw address. Enough to dedupe a
  -- refresh so the click count does not inflate itself; not enough to identify
  -- anybody, which is all the referrals page claims to show.
  "visitorHash" TEXT,
  "source"      TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ReferralClick_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReferralClick_referrerId_createdAt_idx" ON "ReferralClick"("referrerId", "createdAt");
CREATE INDEX "ReferralClick_referrerId_visitorHash_idx" ON "ReferralClick"("referrerId", "visitorHash");

-- Cascade on both sides: a deleted account should not leave ledger rows
-- pointing at nothing, and a referral is meaningless without both parties.
ALTER TABLE "Referral"
  ADD CONSTRAINT "Referral_referrerId_fkey"
  FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Referral"
  ADD CONSTRAINT "Referral_referredId_fkey"
  FOREIGN KEY ("referredId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReferralClick"
  ADD CONSTRAINT "ReferralClick_referrerId_fkey"
  FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: existing referred accounts get a ledger row so their referrer's
-- page is not empty on day one. Status is derived from the old boolean —
-- `referralCreditEarned` means that account already paid and the reward already
-- landed in the legacy counter, so it is CONVERTED with zero new credit rather
-- than PENDING, which would pay a second time on their next renewal.
INSERT INTO "Referral" ("referrerId", "referredId", "status", "creditSen", "signedUpAt", "convertedAt", "updatedAt")
SELECT
  u."referredById",
  u."id",
  CASE WHEN u."referralCreditEarned" THEN 'CONVERTED' ELSE 'PENDING' END,
  0,
  u."createdAt",
  CASE WHEN u."referralCreditEarned" THEN u."createdAt" ELSE NULL END,
  CURRENT_TIMESTAMP
FROM "User" u
WHERE u."referredById" IS NOT NULL
ON CONFLICT ("referredId") DO NOTHING;
