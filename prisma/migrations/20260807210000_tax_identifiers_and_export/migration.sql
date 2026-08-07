-- Spec 05's storage (used by spec 04's CSV) plus the monthly export address.
--
-- Collected quietly. Every field is optional and nothing blocks invoice
-- creation; an account that fills none of them looks exactly as it does today.
-- They are added now rather than later because retroactive collection means
-- emailing an existing user base asking them to go and fill something in.

ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "registrationNumber" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "tin" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "msicCode" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "sstNumber" TEXT;

ALTER TABLE "Client" ADD COLUMN IF NOT EXISTS "registrationNumber" TEXT;
ALTER TABLE "Client" ADD COLUMN IF NOT EXISTS "tin" TEXT;
ALTER TABLE "Client" ADD COLUMN IF NOT EXISTS "isIndividual" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "UserInvoiceConfig" ADD COLUMN IF NOT EXISTS "accountantEmail" TEXT;
