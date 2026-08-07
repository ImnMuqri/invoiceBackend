-- Client import (spec 08): make contact details optional, and add notes.
--
-- WHY email AND company STOP BEING REQUIRED
--
-- A new account is empty and the first invoice means typing a client from
-- scratch. People arrive with their client list already in a phone contact
-- list — which holds a name and a mobile number, and frequently nothing else.
-- With email NOT NULL the only way to store that client was to write "" into
-- the column, and "" is a value: the duplicate check does an equality match on
-- email, so every contactless client would have matched every other one and the
-- second import would have refused them all as duplicates of the first.
--
-- Null means "not known", which is the truth. The rule that actually matters —
-- a client needs a phone number OR an email address to be reachable — is a rule
-- about the PAIR and cannot be written as NOT NULL on either column. It is
-- enforced where it belongs, at the point of sending, and surfaced in the
-- import preview so nobody imports a client they cannot reach without being
-- told.
--
-- DROP NOT NULL is not destructive and needs no backfill: every existing row
-- already satisfies the looser constraint. It is not trivially reversible
-- though — restoring NOT NULL later would need the nulls filled in first.

ALTER TABLE "Client"
  ALTER COLUMN "email" DROP NOT NULL,
  ALTER COLUMN "company" DROP NOT NULL;

-- Free text the user keeps for themselves. Spec 08 lists it among the imported
-- fields, and a spreadsheet of clients almost always has a column that is
-- somebody's own shorthand — "pays late", "invoice via Siti". Never rendered on
-- a document; it is a note to self, not a note to the client.
ALTER TABLE "Client"
  ADD COLUMN "notes" TEXT;

-- Duplicate matching reads phone first, then email, then exact name (spec 08).
-- Without these, importing a 200-row list is 600 sequential scans of the whole
-- client table.
CREATE INDEX "Client_userId_phone_idx" ON "Client"("userId", "phone");
CREATE INDEX "Client_userId_email_idx" ON "Client"("userId", "email");
