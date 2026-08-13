-- Drop the column defaults on the WhatsApp templates, and clear the rows that
-- only ever held the default because the column put it there.
--
-- WHY. These columns mean "the sender's own wording, if they wrote one"; NULL
-- means "use ours". The settings screen is built on exactly that: our text shows
-- as the textarea's placeholder under the words "Leave either blank to use
-- ours". But the column default meant no row was ever NULL, so the fallback in
-- utils/whatsappMessage never ran and the preview and the sent message could
-- disagree — which they did.
--
-- The UPDATEs match the old default string EXACTLY. A sender who edited their
-- template, even by one character, keeps it untouched.

ALTER TABLE "UserNotification" ALTER COLUMN "whatsappSendTemplate" DROP DEFAULT;
ALTER TABLE "UserNotification" ALTER COLUMN "whatsappReminderTemplate" DROP DEFAULT;

UPDATE "UserNotification"
SET "whatsappSendTemplate" = NULL
WHERE "whatsappSendTemplate" = '{{userName}} {{companyName}} via InvoKita

Hello {{clientName}}, here is your invoice {{invoiceNumber}} for {{totalAmount}} {{currency}}. Due on {{dueDate}}. View here: {{invoiceUrl}}';

UPDATE "UserNotification"
SET "whatsappReminderTemplate" = NULL
WHERE "whatsappReminderTemplate" = '{{userName}} {{companyName}} via InvoKita

Friendly reminder for {{clientName}}: Your invoice {{invoiceNumber}} ({{totalAmount}} {{currency}}) is due on {{dueDate}}. Please ignore if already paid.';
