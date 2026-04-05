/*
  Warnings:

  - You are about to drop the column `isPublic` on the `Plan` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Plan" DROP COLUMN "isPublic",
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;
