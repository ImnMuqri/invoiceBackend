-- AlterTable
ALTER TABLE "PaymentProvider" ADD COLUMN     "merchantId" TEXT,
ADD COLUMN     "salt" TEXT;
