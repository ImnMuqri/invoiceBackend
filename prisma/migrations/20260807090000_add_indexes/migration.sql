-- Indexes for every foreign key and hot filter column.
--
-- Prisma does not create indexes on foreign keys, and none had been declared,
-- so the live database had only primary keys and unique constraints. Every
-- query in the app filters by userId, which meant a sequential scan of the whole
-- table across ALL users on every request — cost growing with total rows in the
-- system rather than with the caller's own data.
--
-- CONCURRENTLY so the tables stay writable while these build. That requires
-- each statement to run outside a transaction; Prisma wraps a migration in one,
-- so if this errors with "CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block", drop the CONCURRENTLY keywords and apply during a quiet
-- moment. At current row counts either way is instant.
CREATE INDEX IF NOT EXISTS "Invoice_userId_kind_status_idx" ON "Invoice"("userId", "kind", "status");
CREATE INDEX IF NOT EXISTS "Invoice_userId_kind_date_idx" ON "Invoice"("userId", "kind", "date" DESC);
CREATE INDEX IF NOT EXISTS "Invoice_clientId_idx" ON "Invoice"("clientId");
CREATE INDEX IF NOT EXISTS "Invoice_status_dueDate_idx" ON "Invoice"("status", "dueDate");
CREATE INDEX IF NOT EXISTS "InvoiceItem_invoiceId_idx" ON "InvoiceItem"("invoiceId");
CREATE INDEX IF NOT EXISTS "Client_userId_idx" ON "Client"("userId");
CREATE INDEX IF NOT EXISTS "AppNotification_userId_isRead_idx" ON "AppNotification"("userId", "isRead");
CREATE INDEX IF NOT EXISTS "AppNotification_userId_createdAt_idx" ON "AppNotification"("userId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "PaymentProvider_userId_provider_isActive_idx" ON "PaymentProvider"("userId", "provider", "isActive");
CREATE INDEX IF NOT EXISTS "Ticket_userId_status_idx" ON "Ticket"("userId", "status");
CREATE INDEX IF NOT EXISTS "TicketMessage_ticketId_idx" ON "TicketMessage"("ticketId");
CREATE INDEX IF NOT EXISTS "Subscription_userId_idx" ON "Subscription"("userId");
