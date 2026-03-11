-- AlterTable
ALTER TABLE "User" ADD COLUMN     "twilioAuthToken" TEXT,
ADD COLUMN     "twilioPhoneNumber" TEXT,
ADD COLUMN     "twilioSid" TEXT,
ADD COLUMN     "whatsappMode" TEXT NOT NULL DEFAULT 'SYSTEM',
ALTER COLUMN "whatsappReminderTemplate" SET DEFAULT '{{userName}} {{companyName}} via InvoMate

Friendly reminder for {{clientName}}: Your invoice {{invoiceNumber}} ({{totalAmount}} {{currency}}) is due on {{dueDate}}. Please ignore if already paid.',
ALTER COLUMN "whatsappSendTemplate" SET DEFAULT '{{userName}} {{companyName}} via InvoMate

Hello {{clientName}}, here is your invoice {{invoiceNumber}} for {{totalAmount}} {{currency}}. Due on {{dueDate}}. View here: {{invoiceUrl}}';
