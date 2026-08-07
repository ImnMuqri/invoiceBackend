-- Quotations: the closed loop (spec 07).
--
-- Quotes already existed as documents. What they could not do was come back
-- with an answer: the user sent one and then tracked the outcome in their head.
-- These columns are the loop closing — a link the client can open, two buttons,
-- and a record of which one they pressed.
--
-- Two things worth knowing about the shape:
--
--   1. "publicToken" is a token, not the row id. The public INVOICE page can
--      live on an integer (/pay/:id) because the worst a stranger does by
--      walking it is look. Accepting and declining WRITE, so an enumerable url
--      would let anybody mark anybody's quotations accepted. Unique so a
--      collision is a database error rather than one client answering another
--      client's quote.
--
--   2. "expiryNotifiedAt" is a timestamp rather than a boolean. The spec asks
--      for the owner to be told ONCE when a quote lapses; storing when means a
--      quote whose validity is later extended can lapse — and be reported —
--      again, which a boolean would have silently swallowed.
--
-- Every column is nullable, so this is safe on a live table and existing rows
-- (invoices and quotes alike) are untouched. Existing quotes simply have no
-- token yet; one is minted the first time their public link is asked for.

ALTER TABLE "Invoice"
  ADD COLUMN "publicToken"      TEXT,
  ADD COLUMN "viewedAt"         TIMESTAMP(3),
  ADD COLUMN "acceptedAt"       TIMESTAMP(3),
  ADD COLUMN "acceptedName"     TEXT,
  ADD COLUMN "acceptedIp"       TEXT,
  ADD COLUMN "declinedAt"       TIMESTAMP(3),
  ADD COLUMN "declineReason"    TEXT,
  ADD COLUMN "expiryNotifiedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Invoice_publicToken_key" ON "Invoice"("publicToken");

-- The nightly expiry sweep filters on exactly this, and without an index it is
-- a full scan of every document in the system once a day, forever.
CREATE INDEX "Invoice_kind_status_validUntil_idx" ON "Invoice"("kind", "status", "validUntil");
