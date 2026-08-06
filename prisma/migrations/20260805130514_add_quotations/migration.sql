-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "convertedFromId" INTEGER,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'INVOICE',
ADD COLUMN     "userQuoteNumber" INTEGER,
ADD COLUMN     "validUntil" TIMESTAMP(3),
ALTER COLUMN "dueDate" DROP NOT NULL;
-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "quotes" INTEGER NOT NULL DEFAULT 0;
-- AlterTable
ALTER TABLE "UserInvoiceConfig" ADD COLUMN     "quotePrefix" TEXT NOT NULL DEFAULT 'QUO';
-- AlterTable
ALTER TABLE "UserQuota" ADD COLUMN     "quotesUsed" INTEGER NOT NULL DEFAULT 0;
-- CreateIndex
CREATE UNIQUE INDEX "Invoice_convertedFromId_key" ON "Invoice"("convertedFromId");
-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_convertedFromId_fkey" FOREIGN KEY ("convertedFromId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
