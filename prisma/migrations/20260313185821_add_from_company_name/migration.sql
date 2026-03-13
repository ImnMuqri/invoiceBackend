-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "fromCompanyName" TEXT;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "whatsappReminderTemplate" SET DEFAULT '{{userName}} {{companyName}} via InvoKita

Friendly reminder for {{clientName}}: Your invoice {{invoiceNumber}} ({{totalAmount}} {{currency}}) is due on {{dueDate}}. Please ignore if already paid.',
ALTER COLUMN "whatsappSendTemplate" SET DEFAULT '{{userName}} {{companyName}} via InvoKita

Hello {{clientName}}, here is your invoice {{invoiceNumber}} for {{totalAmount}} {{currency}}. Due on {{dueDate}}. View here: {{invoiceUrl}}';
