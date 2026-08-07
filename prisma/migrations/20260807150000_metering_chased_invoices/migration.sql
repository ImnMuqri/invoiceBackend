-- Spec 01: meter the chased invoice, not the message.
--
-- Invoice creation costs nothing to serve; WhatsApp messages do. Plans
-- advertised an invoice count as the headline while the binding constraint was
-- a much smaller WhatsApp number, so the advertised figure was never the one
-- that ran out.

-- ── Plan: the new metered unit ──────────────────────────────────────────────
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "chasedInvoices" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "trialChases" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "waPerInvoiceCap" INTEGER NOT NULL DEFAULT 6;

-- ── UserQuota: the one-time trial grant, which never resets ─────────────────
ALTER TABLE "UserQuota" ADD COLUMN IF NOT EXISTS "trialChasesUsed" INTEGER NOT NULL DEFAULT 0;

-- ── Invoice: chase bookkeeping ─────────────────────────────────────────────
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "chasedInPeriod" TEXT;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "waMessageCount" INTEGER NOT NULL DEFAULT 0;

-- ── Subscription: freeze allowances at subscribe time ──────────────────────
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "allowances" JSONB;

-- ── UsagePeriod ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "UsagePeriod" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "periodKey" TEXT NOT NULL,
    "chasedInvoices" INTEGER NOT NULL DEFAULT 0,
    "waMessages" INTEGER NOT NULL DEFAULT 0,
    "emailMessages" INTEGER NOT NULL DEFAULT 0,
    "downgrades" INTEGER NOT NULL DEFAULT 0,
    "downgradeNotified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UsagePeriod_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "UsagePeriod_userId_periodKey_key" ON "UsagePeriod"("userId", "periodKey");
CREATE INDEX IF NOT EXISTS "UsagePeriod_userId_idx" ON "UsagePeriod"("userId");
ALTER TABLE "UsagePeriod" ADD CONSTRAINT "UsagePeriod_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── TopUp ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TopUp" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "chasedInvoices" INTEGER NOT NULL,
    "consumed" INTEGER NOT NULL DEFAULT 0,
    "periodKey" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MYR',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "paymentRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TopUp_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "TopUp_paymentRef_key" ON "TopUp"("paymentRef");
CREATE INDEX IF NOT EXISTS "TopUp_userId_periodKey_status_idx" ON "TopUp"("userId", "periodKey", "status");
ALTER TABLE "TopUp" ADD CONSTRAINT "TopUp_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── MessageLog ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "MessageLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "invoiceId" INTEGER,
    "channel" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'NA',
    "downgraded" BOOLEAN NOT NULL DEFAULT false,
    "downgradeReason" TEXT,
    "providerRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "MessageLog_userId_createdAt_idx" ON "MessageLog"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "MessageLog_invoiceId_idx" ON "MessageLog"("invoiceId");
ALTER TABLE "MessageLog" ADD CONSTRAINT "MessageLog_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageLog" ADD CONSTRAINT "MessageLog_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── The new plan shape ─────────────────────────────────────────────────────
-- Paid plans stop metering invoices, email and AI: none of them is a real cost,
-- and a gap there makes the cheaper plan feel crippled without protecting
-- anything. 999999 is the app's "unlimited" sentinel.
UPDATE "Plan" SET
  "invoices" = 999999, "quotes" = 999999, "emailSends" = 999999,
  "emailReminders" = 999999, "aiCredits" = 999999
WHERE "name" IN ('PRO', 'MAX');

-- Placeholder allowances. These are the numbers to revisit once the real
-- per-message cost is known; they are plan columns precisely so that is an
-- admin edit and not a deploy.
UPDATE "Plan" SET "chasedInvoices" = 25 WHERE "name" = 'PRO';
UPDATE "Plan" SET "chasedInvoices" = 75 WHERE "name" = 'MAX';

-- Free: no monthly WhatsApp allowance, but a one-time grant of 3 chases so a
-- free account sees a full cycle complete before deciding.
UPDATE "Plan" SET "chasedInvoices" = 0, "trialChases" = 3 WHERE "name" = 'FREE';
