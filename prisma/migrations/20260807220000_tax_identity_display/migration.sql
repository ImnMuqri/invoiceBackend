-- Tax identity fields, part 2 (spec 05).
--
-- The storage for the identifiers themselves landed with spec 04's migration,
-- because the accountant export's column set depends on them. This migration
-- adds what is needed to DISPLAY them:
--
--   1. Four snapshot columns on Invoice. Identifiers are frozen at issue, the
--      same way fromName/fromCompanyName/fromAddress already are. Correcting a
--      typo in your TIN must not rewrite an invoice a client already holds a
--      PDF of.
--   2. Two switches on UserInvoiceConfig, one per block, for the user who has
--      entered their identifiers and does not want them on the document.
--   3. One flag on UserProfile for the single dismissable prompt.
--
-- Every column is nullable or defaulted, so this is safe on a live table and an
-- account that fills nothing in sees no change anywhere.

ALTER TABLE "Invoice"
  ADD COLUMN "fromRegistrationNumber" TEXT,
  ADD COLUMN "fromTin"                TEXT,
  ADD COLUMN "fromMsicCode"           TEXT,
  ADD COLUMN "fromSstNumber"          TEXT;

ALTER TABLE "UserInvoiceConfig"
  ADD COLUMN "invoiceIncludeTaxIdentifiers"    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "invoiceIncludeClientIdentifiers" BOOLEAN NOT NULL DEFAULT true;

-- Defaulted true on purpose. A user who has bothered to enter a TIN wants it on
-- the document; making them find a switch afterwards would be the wrong way
-- round. It is still only rendered when the field is actually filled in.

ALTER TABLE "UserProfile"
  ADD COLUMN "taxPromptDismissed" BOOLEAN NOT NULL DEFAULT false;
