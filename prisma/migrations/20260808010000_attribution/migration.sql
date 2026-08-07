-- Attribution on client-facing documents (spec 09, part A).
--
-- "Sent with InvoKita" at the foot of the public payment page and the invoice
-- PDF. Every invoice this product sends lands in front of a second person who
-- is very often somebody who also sends invoices — distribution built into the
-- product rather than bought.
--
-- WHY THIS IS ONE COLUMN AND NOT A TIER CHECK
--
-- The rule has two halves and only one of them belongs in the database:
--
--   free tier  → always shown, cannot be removed. Not stored, because it is
--                not the account's choice to record.
--   paid plans → shown by DEFAULT, removable here.
--
-- Deliberately not gated to the top tier. Pro and Max differ on volume, and
-- making somebody upgrade twice to take our line off their own invoice is how
-- an account is lost rather than grown.
--
-- The halves are combined in exactly one place, src/utils/attribution.js, which
-- both the PDF endpoint and the public payment endpoint call. Before this, the
-- two surfaces each decided for themselves and disagreed: the payment page hid
-- its watermark for Max accounts while the PDF printed its footer for
-- everybody, so a Max customer's client saw it stripped from the page they were
-- sent and still present on the document attached to it.
--
-- Defaulted true so existing accounts keep showing what they already showed.

ALTER TABLE "UserInvoiceConfig"
  ADD COLUMN "attributionEnabled" BOOLEAN NOT NULL DEFAULT true;
