-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "autoChaser" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "template" TEXT NOT NULL DEFAULT 'professional',
ADD COLUMN     "whatsappLastReminderSent" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "whatsappReminderTemplate" TEXT DEFAULT 'Hi {{clientName}}, this is a friendly reminder that invoice {{invoiceNumber}} is still pending. Total amount: {{totalAmount}} {{currency}}.',
ADD COLUMN     "whatsappSendTemplate" TEXT DEFAULT 'Hello {{clientName}}, here is your invoice {{invoiceNumber}} for {{totalAmount}} {{currency}}. Due on {{dueDate}}.';
