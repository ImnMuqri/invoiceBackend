/*
  Warnings:

  - You are about to drop the `Profile` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Profile" DROP CONSTRAINT "Profile_userId_fkey";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "address" TEXT,
ADD COLUMN     "companyEmail" TEXT,
ADD COLUMN     "companyName" TEXT,
ADD COLUMN     "companyPhone" TEXT,
ADD COLUMN     "defaultCurrency" TEXT NOT NULL DEFAULT 'MYR',
ADD COLUMN     "defaultTaxRate" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
ADD COLUMN     "globalAutoChaser" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "invoiceIncludeAddress" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "invoiceIncludeCompanyName" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "invoiceIncludeCompanyPhone" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "invoiceIncludeEmail" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "invoiceIncludeName" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "invoiceIncludePersonalPhone" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "invoicePrefix" TEXT NOT NULL DEFAULT 'INV',
ADD COLUMN     "manualAccountName" TEXT,
ADD COLUMN     "manualAccountNumber" TEXT,
ADD COLUMN     "manualBankName" TEXT,
ADD COLUMN     "manualQrCode" TEXT,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "phoneNumber" TEXT,
ADD COLUMN     "reminderInterval" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "twilioAuthToken" TEXT,
ADD COLUMN     "twilioPhoneNumber" TEXT,
ADD COLUMN     "twilioSid" TEXT,
ADD COLUMN     "whatsappMode" TEXT NOT NULL DEFAULT 'SYSTEM',
ADD COLUMN     "whatsappReminderInterval" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "whatsappReminderTemplate" TEXT DEFAULT '{{userName}} {{companyName}} via InvoKita

Friendly reminder for {{clientName}}: Your invoice {{invoiceNumber}} ({{totalAmount}} {{currency}}) is due on {{dueDate}}. Please ignore if already paid.',
ADD COLUMN     "whatsappSendTemplate" TEXT DEFAULT '{{userName}} {{companyName}} via InvoKita

Hello {{clientName}}, here is your invoice {{invoiceNumber}} for {{totalAmount}} {{currency}}. Due on {{dueDate}}. View here: {{invoiceUrl}}';

-- DropTable
DROP TABLE "Profile";
