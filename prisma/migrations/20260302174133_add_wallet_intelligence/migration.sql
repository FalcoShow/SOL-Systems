-- CreateEnum
CREATE TYPE "IntelligenceStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETE', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'INTELLIGENCE_REPORT';
ALTER TYPE "NotificationType" ADD VALUE 'INTELLIGENCE_FAILED';

-- AlterTable
ALTER TABLE "tracked_wallets" ADD COLUMN     "addedByAI" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "aiAddedAt" TIMESTAMP(3),
ADD COLUMN     "aiRemovedAt" TIMESTAMP(3),
ADD COLUMN     "intelligenceId" TEXT;

-- CreateTable
CREATE TABLE "wallet_intelligence" (
    "id" TEXT NOT NULL,
    "forDate" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capitalSOL" DOUBLE PRECISION NOT NULL,
    "walletsRecommended" INTEGER NOT NULL DEFAULT 0,
    "walletsAdded" INTEGER NOT NULL DEFAULT 0,
    "walletsRemoved" INTEGER NOT NULL DEFAULT 0,
    "reportJson" JSONB NOT NULL,
    "telegramSummary" TEXT NOT NULL,
    "htmlReport" TEXT NOT NULL,
    "status" "IntelligenceStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "addedWallets" JSONB NOT NULL DEFAULT '[]',
    "removedWallets" JSONB NOT NULL DEFAULT '[]',
    "birdeyeDataQuality" INTEGER NOT NULL DEFAULT 0,
    "gmgnDataQuality" INTEGER NOT NULL DEFAULT 0,
    "cieloDataQuality" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "wallet_intelligence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_intelligence_forDate_key" ON "wallet_intelligence"("forDate");

-- CreateIndex
CREATE INDEX "wallet_intelligence_forDate_idx" ON "wallet_intelligence"("forDate");

-- CreateIndex
CREATE INDEX "wallet_intelligence_status_idx" ON "wallet_intelligence"("status");

-- CreateIndex
CREATE INDEX "tracked_wallets_addedByAI_idx" ON "tracked_wallets"("addedByAI");
