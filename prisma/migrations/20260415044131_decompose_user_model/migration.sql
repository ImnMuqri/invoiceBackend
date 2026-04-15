/*
  Warnings:

  - You are about to drop the column `address` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `aiInsights` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `aiUsed` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `companyEmail` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `companyName` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `companyPhone` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `currentStatus` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `defaultCurrency` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `defaultTaxRate` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `emailRemindersUsed` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `emailSendsUsed` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `globalAutoChaser` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `heardAbout` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `invoiceIncludeAddress` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `invoiceIncludeCompanyName` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `invoiceIncludeCompanyPhone` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `invoiceIncludeEmail` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `invoiceIncludeName` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `invoiceIncludePersonalPhone` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `invoicePrefix` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `invoicesUsed` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `lastAiInsightAt` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `lastResetDate` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `manualAccountName` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `manualAccountNumber` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `manualBankName` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `manualQrCode` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `phoneNumber` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `reminderInterval` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `twilioAuthToken` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `twilioPhoneNumber` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `twilioSid` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `waRemindersUsed` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `waSendsUsed` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `whatsappMode` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `whatsappReminderInterval` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `whatsappReminderTemplate` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `whatsappSendTemplate` on the `User` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "User" DROP COLUMN "address",
DROP COLUMN "aiInsights",
DROP COLUMN "aiUsed",
DROP COLUMN "companyEmail",
DROP COLUMN "companyName",
DROP COLUMN "companyPhone",
DROP COLUMN "currentStatus",
DROP COLUMN "defaultCurrency",
DROP COLUMN "defaultTaxRate",
DROP COLUMN "emailRemindersUsed",
DROP COLUMN "emailSendsUsed",
DROP COLUMN "globalAutoChaser",
DROP COLUMN "heardAbout",
DROP COLUMN "invoiceIncludeAddress",
DROP COLUMN "invoiceIncludeCompanyName",
DROP COLUMN "invoiceIncludeCompanyPhone",
DROP COLUMN "invoiceIncludeEmail",
DROP COLUMN "invoiceIncludeName",
DROP COLUMN "invoiceIncludePersonalPhone",
DROP COLUMN "invoicePrefix",
DROP COLUMN "invoicesUsed",
DROP COLUMN "lastAiInsightAt",
DROP COLUMN "lastResetDate",
DROP COLUMN "manualAccountName",
DROP COLUMN "manualAccountNumber",
DROP COLUMN "manualBankName",
DROP COLUMN "manualQrCode",
DROP COLUMN "name",
DROP COLUMN "phoneNumber",
DROP COLUMN "reminderInterval",
DROP COLUMN "twilioAuthToken",
DROP COLUMN "twilioPhoneNumber",
DROP COLUMN "twilioSid",
DROP COLUMN "waRemindersUsed",
DROP COLUMN "waSendsUsed",
DROP COLUMN "whatsappMode",
DROP COLUMN "whatsappReminderInterval",
DROP COLUMN "whatsappReminderTemplate",
DROP COLUMN "whatsappSendTemplate";

-- CreateTable
CREATE TABLE "UserProfile" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT,
    "phoneNumber" TEXT,
    "heardAbout" TEXT,
    "currentStatus" TEXT,
    "companyName" TEXT,
    "companyEmail" TEXT,
    "companyPhone" TEXT,
    "address" TEXT,
    "defaultCurrency" TEXT NOT NULL DEFAULT 'MYR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserQuota" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "waSendsUsed" INTEGER NOT NULL DEFAULT 0,
    "emailSendsUsed" INTEGER NOT NULL DEFAULT 0,
    "waRemindersUsed" INTEGER NOT NULL DEFAULT 0,
    "emailRemindersUsed" INTEGER NOT NULL DEFAULT 0,
    "aiUsed" INTEGER NOT NULL DEFAULT 0,
    "invoicesUsed" INTEGER NOT NULL DEFAULT 0,
    "lastResetDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserQuota_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserNotification" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "reminderInterval" INTEGER NOT NULL DEFAULT 0,
    "whatsappReminderInterval" INTEGER NOT NULL DEFAULT 0,
    "whatsappMode" TEXT NOT NULL DEFAULT 'SYSTEM',
    "whatsappSendTemplate" TEXT DEFAULT '{{userName}} {{companyName}} via InvoKita

Hello {{clientName}}, here is your invoice {{invoiceNumber}} for {{totalAmount}} {{currency}}. Due on {{dueDate}}. View here: {{invoiceUrl}}',
    "whatsappReminderTemplate" TEXT DEFAULT '{{userName}} {{companyName}} via InvoKita

Friendly reminder for {{clientName}}: Your invoice {{invoiceNumber}} ({{totalAmount}} {{currency}}) is due on {{dueDate}}. Please ignore if already paid.',
    "twilioSid" TEXT,
    "twilioAuthToken" TEXT,
    "twilioPhoneNumber" TEXT,
    "globalAutoChaser" BOOLEAN NOT NULL DEFAULT true,
    "aiInsights" TEXT,
    "lastAiInsightAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserInvoiceConfig" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "invoicePrefix" TEXT NOT NULL DEFAULT 'INV',
    "defaultTaxRate" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "invoiceIncludeName" BOOLEAN NOT NULL DEFAULT true,
    "invoiceIncludeEmail" BOOLEAN NOT NULL DEFAULT false,
    "invoiceIncludePersonalPhone" BOOLEAN NOT NULL DEFAULT false,
    "invoiceIncludeCompanyPhone" BOOLEAN NOT NULL DEFAULT true,
    "invoiceIncludeCompanyName" BOOLEAN NOT NULL DEFAULT true,
    "invoiceIncludeAddress" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserInvoiceConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualPayment" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "bankName" TEXT,
    "accountNumber" TEXT,
    "accountName" TEXT,
    "qrCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_userId_key" ON "UserProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserQuota_userId_key" ON "UserQuota"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserNotification_userId_key" ON "UserNotification"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserInvoiceConfig_userId_key" ON "UserInvoiceConfig"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ManualPayment_userId_key" ON "ManualPayment"("userId");

-- AddForeignKey
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserQuota" ADD CONSTRAINT "UserQuota_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserNotification" ADD CONSTRAINT "UserNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserInvoiceConfig" ADD CONSTRAINT "UserInvoiceConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualPayment" ADD CONSTRAINT "ManualPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
