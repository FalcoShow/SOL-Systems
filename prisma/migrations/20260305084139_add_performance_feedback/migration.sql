-- AlterTable
ALTER TABLE "tracked_wallets" ADD COLUMN     "performanceScore" DOUBLE PRECISION,
ADD COLUMN     "performanceScoredAt" TIMESTAMP(3),
ADD COLUMN     "performanceTrades" INTEGER DEFAULT 0;
