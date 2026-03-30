/*
  Warnings:

  - You are about to drop the column `riskScore` on the `Client` table. All the data in the column will be lost.
  - You are about to drop the column `riskScore` on the `Invoice` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Client" DROP COLUMN "riskScore";

-- AlterTable
ALTER TABLE "Invoice" DROP COLUMN "riskScore";
