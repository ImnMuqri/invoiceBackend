-- Narrower defaults for what prints on a document.
--
-- A new account now opens with the BUSINESS three switched on — name, phone,
-- email — and nothing else. Previously the personal name, the business address
-- and both tax-identifier blocks defaulted on as well, so the settings page
-- greeted people with eight switches they had never chosen, and a freelancer's
-- own mobile number went onto every invoice they issued without being asked.
--
-- ONLY NEW ROWS ARE AFFECTED. Changing a column default does not touch existing
-- data, which is what we want: an account that has deliberately turned its
-- address on keeps it on. Nobody's invoices change appearance because of this
-- migration.
--
-- Two of these are not merely defaulted but ENFORCED, in
-- src/utils/documentFields.js and in the settings UI: the business name always
-- prints, and at least one contact — phone or email — always prints. A document
-- that names nobody, or names somebody unreachable, is not a document. The rule
-- is about the pair rather than a specific column, because requiring the phone
-- would be wrong for a business that trades only by email and requiring the
-- email would be wrong for the many that run on WhatsApp.

ALTER TABLE "UserInvoiceConfig"
  ALTER COLUMN "invoiceIncludeName"              SET DEFAULT false,
  ALTER COLUMN "invoiceIncludeEmail"             SET DEFAULT true,
  ALTER COLUMN "invoiceIncludeAddress"           SET DEFAULT false,
  ALTER COLUMN "invoiceIncludeTaxIdentifiers"    SET DEFAULT false,
  ALTER COLUMN "invoiceIncludeClientIdentifiers" SET DEFAULT false;

-- Repair any existing row that violates the enforced rules. There should be
-- none — the old defaults had both on — but a row edited before enforcement
-- existed could have neither contact, and that row would silently issue
-- invoices nobody can reply to.
UPDATE "UserInvoiceConfig" SET "invoiceIncludeCompanyName" = true
  WHERE "invoiceIncludeCompanyName" = false;

UPDATE "UserInvoiceConfig" SET "invoiceIncludeCompanyPhone" = true
  WHERE "invoiceIncludeCompanyPhone" = false AND "invoiceIncludeEmail" = false;
