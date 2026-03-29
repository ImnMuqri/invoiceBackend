-- AlterTable
ALTER TABLE "User" ADD COLUMN     "companyPhone" TEXT,
ADD COLUMN     "reminderInterval" INTEGER NOT NULL DEFAULT 0;
