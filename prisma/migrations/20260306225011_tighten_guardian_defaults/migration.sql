-- AlterTable
ALTER TABLE "settings" ALTER COLUMN "maxHoldTimeHours" SET DEFAULT 18.0,
ALTER COLUMN "stopLossPct" SET DEFAULT -25.0,
ALTER COLUMN "takeProfitPct" SET DEFAULT 75.0,
ALTER COLUMN "trailingStopActivatePct" SET DEFAULT 25.0;
