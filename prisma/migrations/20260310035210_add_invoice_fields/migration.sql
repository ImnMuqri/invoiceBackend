/*
  Warnings:

  - You are about to drop the column `description` on the `InvoiceItem` table. All the data in the column will be lost.
  - Added the required column `name` to the `InvoiceItem` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "invoiceName" TEXT,
ADD COLUMN     "invoiceNumber" TEXT,
ADD COLUMN     "subject" TEXT;

-- AlterTable
ALTER TABLE "InvoiceItem" DROP COLUMN "description",
ADD COLUMN     "name" TEXT NOT NULL;
