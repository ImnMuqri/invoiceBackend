-- Spec 02: recurring schedules.
--
-- A schedule is a template plus a cadence. It is not an invoice and never has a
-- paid status; it generates instances, which are ordinary invoices.

CREATE TABLE IF NOT EXISTS "RecurringSchedule" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "clientId" INTEGER NOT NULL,
    "invoiceName" TEXT,
    "subject" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'MYR',
    "taxRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "frequency" TEXT NOT NULL DEFAULT 'MONTHLY',
    "interval" INTEGER NOT NULL DEFAULT 1,
    "issueDay" INTEGER,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endMode" TEXT NOT NULL DEFAULT 'NEVER',
    "endAfter" INTEGER,
    "endDate" TIMESTAMP(3),
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 14,
    "channels" TEXT[] DEFAULT ARRAY['EMAIL']::TEXT[],
    "autoChase" BOOLEAN NOT NULL DEFAULT true,
    "reminderInterval" INTEGER,
    "mode" TEXT NOT NULL DEFAULT 'REVIEW',
    "reviewRemaining" INTEGER NOT NULL DEFAULT 2,
    "reviewPromptSent" BOOLEAN NOT NULL DEFAULT false,
    "skipWhileUnpaid" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "statusReason" TEXT,
    "occurrences" INTEGER NOT NULL DEFAULT 0,
    "lastPeriodKey" TEXT,
    "nextIssueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RecurringSchedule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "RecurringSchedule_userId_status_idx" ON "RecurringSchedule"("userId", "status");
CREATE INDEX IF NOT EXISTS "RecurringSchedule_status_nextIssueAt_idx" ON "RecurringSchedule"("status", "nextIssueAt");
CREATE INDEX IF NOT EXISTS "RecurringSchedule_clientId_idx" ON "RecurringSchedule"("clientId");
ALTER TABLE "RecurringSchedule" ADD CONSTRAINT "RecurringSchedule_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecurringSchedule" ADD CONSTRAINT "RecurringSchedule_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "RecurringItem" (
    "id" SERIAL NOT NULL,
    "scheduleId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "RecurringItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "RecurringItem_scheduleId_idx" ON "RecurringItem"("scheduleId");
ALTER TABLE "RecurringItem" ADD CONSTRAINT "RecurringItem_scheduleId_fkey"
  FOREIGN KEY ("scheduleId") REFERENCES "RecurringSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Instance bookkeeping. The unique constraint is what makes generation
-- idempotent: a job that runs twice in one day cannot produce two invoices for
-- the same schedule period, whatever the retry or overlap looks like.
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "scheduleId" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "schedulePeriod" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_scheduleId_schedulePeriod_key"
  ON "Invoice"("scheduleId", "schedulePeriod");
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_scheduleId_fkey"
  FOREIGN KEY ("scheduleId") REFERENCES "RecurringSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
