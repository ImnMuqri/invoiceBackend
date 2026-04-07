/*
  Warnings:

  - You are about to drop the column `address` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `companyEmail` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `companyName` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `companyPhone` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `defaultCurrency` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `defaultTaxRate` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `globalAutoChaser` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `invoiceIncludeAddress` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `invoiceIncludeCompanyName` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `invoiceIncludeCompanyPhone` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `invoiceIncludeEmail` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `invoiceIncludeName` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `invoiceIncludePersonalPhone` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `invoicePrefix` on the `User` table. All the data in the column will be lost.
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
  - You are about to drop the column `whatsappMode` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `whatsappReminderInterval` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `whatsappReminderTemplate` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `whatsappSendTemplate` on the `User` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "User" DROP COLUMN "address",
DROP COLUMN "companyEmail",
DROP COLUMN "companyName",
DROP COLUMN "companyPhone",
DROP COLUMN "defaultCurrency",
DROP COLUMN "defaultTaxRate",
DROP COLUMN "globalAutoChaser",
DROP COLUMN "invoiceIncludeAddress",
DROP COLUMN "invoiceIncludeCompanyName",
DROP COLUMN "invoiceIncludeCompanyPhone",
DROP COLUMN "invoiceIncludeEmail",
DROP COLUMN "invoiceIncludeName",
DROP COLUMN "invoiceIncludePersonalPhone",
DROP COLUMN "invoicePrefix",
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
DROP COLUMN "whatsappMode",
DROP COLUMN "whatsappReminderInterval",
DROP COLUMN "whatsappReminderTemplate",
DROP COLUMN "whatsappSendTemplate";
