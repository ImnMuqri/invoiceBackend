-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "globalAutoChaser" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "invoiceIncludeAddress" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "invoiceIncludeCompanyName" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "invoiceIncludeCompanyPhone" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "invoiceIncludeEmail" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "invoiceIncludeName" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "invoiceIncludePersonalPhone" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "invoicePrefix" TEXT NOT NULL DEFAULT 'INV';
