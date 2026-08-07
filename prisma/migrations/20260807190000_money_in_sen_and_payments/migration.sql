-- Spec 03: money in integer sen, plus payments, credit notes and voiding.
--
-- WHY INTEGERS. Float cannot represent most decimal fractions exactly:
--   0.1 + 0.2 = 0.30000000000000004
-- Spec 03 requires amount_due to reconcile exactly, and spec 04 requires the
-- CSV export to reconcile "exactly" with the dashboard. Neither promise can be
-- kept on floats. Sen is the smallest unit the currency has, so every amount is
-- a whole number of them.
--
-- ROUND(x * 100) rather than a cast: the stored floats are already the closest
-- double to a 2dp value, so rounding recovers the intended figure. A truncating
-- cast would turn 34.499999999999996 into 3449 instead of 3450.

-- ── Invoice ────────────────────────────────────────────────────────────────
ALTER TABLE "Invoice"
  ALTER COLUMN "amount" TYPE INTEGER USING ROUND("amount" * 100),
  ALTER COLUMN "amountPaid" TYPE INTEGER USING ROUND("amountPaid" * 100),
  ALTER COLUMN "amountPaid" SET DEFAULT 0;

ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "amountAdjusted" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "amountDue" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "voidedAt" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "voidReason" TEXT;

-- Seed the derived column from what is already known.
UPDATE "Invoice" SET "amountDue" = "amount" - "amountPaid" - "amountAdjusted";

-- ── InvoiceItem ────────────────────────────────────────────────────────────
ALTER TABLE "InvoiceItem"
  ALTER COLUMN "price" TYPE INTEGER USING ROUND("price" * 100),
  ALTER COLUMN "total" TYPE INTEGER USING ROUND("total" * 100);

-- ── Everything else that is money ──────────────────────────────────────────
ALTER TABLE "Plan" ALTER COLUMN "price" TYPE INTEGER USING ROUND("price" * 100),
                   ALTER COLUMN "price" SET DEFAULT 0;
ALTER TABLE "Subscription" ALTER COLUMN "amount" TYPE INTEGER USING ROUND("amount" * 100);
ALTER TABLE "TopUp" ALTER COLUMN "price" TYPE INTEGER USING ROUND("price" * 100);
ALTER TABLE "RecurringItem" ALTER COLUMN "price" TYPE INTEGER USING ROUND("price" * 100);
ALTER TABLE "CatalogueItem" ALTER COLUMN "price" TYPE INTEGER USING ROUND("price" * 100),
                            ALTER COLUMN "price" SET DEFAULT 0;
ALTER TABLE "Client" ALTER COLUMN "totalRevenue" TYPE INTEGER USING ROUND("totalRevenue" * 100),
                     ALTER COLUMN "totalRevenue" SET DEFAULT 0;

-- ── Credit note numbering ──────────────────────────────────────────────────
ALTER TABLE "UserInvoiceConfig" ADD COLUMN IF NOT EXISTS "creditNotePrefix" TEXT NOT NULL DEFAULT 'CN';

-- ── Payment ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Payment" (
    "id" SERIAL NOT NULL,
    "invoiceId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT NOT NULL DEFAULT 'OTHER',
    "reference" TEXT,
    "note" TEXT,
    "automatic" BOOLEAN NOT NULL DEFAULT false,
    "gatewayRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);
-- Unique so a webhook delivered twice cannot record the same money twice.
CREATE UNIQUE INDEX IF NOT EXISTS "Payment_gatewayRef_key" ON "Payment"("gatewayRef");
CREATE INDEX IF NOT EXISTS "Payment_invoiceId_idx" ON "Payment"("invoiceId");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing settled invoices get a payment record, so the new model does not
-- start out disagreeing with the old flag. Method is unknown for these — they
-- predate payment records — so they are marked as such rather than guessed at.
INSERT INTO "Payment" ("invoiceId", "amount", "receivedAt", "method", "note", "automatic", "updatedAt")
SELECT "id", "amountPaid", COALESCE("paidAt", "updatedAt"), 'OTHER',
       'Recorded before payment history existed', false, CURRENT_TIMESTAMP
FROM "Invoice"
WHERE "amountPaid" > 0;

-- ── CreditNote ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "CreditNote" (
    "id" SERIAL NOT NULL,
    "invoiceId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "userNumber" INTEGER NOT NULL,
    "number" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CreditNote_invoiceId_idx" ON "CreditNote"("invoiceId");
CREATE INDEX IF NOT EXISTS "CreditNote_userId_idx" ON "CreditNote"("userId");
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
