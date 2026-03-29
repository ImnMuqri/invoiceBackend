-- AlterTable
ALTER TABLE "User" ADD COLUMN     "currentStatus" TEXT,
ADD COLUMN     "heardAbout" TEXT,
ADD COLUMN     "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "phoneNumber" TEXT;
