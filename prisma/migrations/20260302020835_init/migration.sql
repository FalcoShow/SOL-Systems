-- CreateEnum
CREATE TYPE "TradeType" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "TradeStatus" AS ENUM ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('BUY_EXECUTED', 'SELL_EXECUTED', 'TRADE_FAILED', 'TRADE_SKIPPED', 'DAILY_REPORT', 'SYSTEM_ONLINE', 'SYSTEM_PAUSED', 'SYSTEM_RESUMED', 'LOSS_LIMIT_HIT', 'WALLET_ADDED', 'WALLET_REMOVED', 'ERROR_ALERT');

-- CreateTable
CREATE TABLE "tracked_wallets" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "estimatedCapitalSOL" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "capitalUpdatedAt" TIMESTAMP(3),
    "manualCapitalSOL" DOUBLE PRECISION,
    "totalTradesCopied" INTEGER NOT NULL DEFAULT 0,
    "totalWins" INTEGER NOT NULL DEFAULT 0,
    "totalLosses" INTEGER NOT NULL DEFAULT 0,
    "totalPnLSOL" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "lastTradeAt" TIMESTAMP(3),

    CONSTRAINT "tracked_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_trades" (
    "id" TEXT NOT NULL,
    "trackedWalletId" TEXT NOT NULL,
    "txSignature" TEXT NOT NULL,
    "blockTime" TIMESTAMP(3) NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tradeType" "TradeType" NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "tokenSymbol" TEXT,
    "tokenName" TEXT,
    "amountSOL" DOUBLE PRECISION NOT NULL,
    "amountTokens" DOUBLE PRECISION NOT NULL,
    "pricePerTokenSOL" DOUBLE PRECISION NOT NULL,
    "pricePerTokenUSD" DOUBLE PRECISION,
    "entryTradeId" TEXT,
    "pnlSOL" DOUBLE PRECISION,
    "pnlUSD" DOUBLE PRECISION,
    "pnlPct" DOUBLE PRECISION,
    "isWin" BOOLEAN,
    "trackedCapitalSOL" DOUBLE PRECISION,

    CONSTRAINT "wallet_trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "trackedWalletId" TEXT NOT NULL,
    "walletTradeId" TEXT NOT NULL,
    "txSignature" TEXT,
    "status" "TradeStatus" NOT NULL DEFAULT 'PENDING',
    "tradeType" "TradeType" NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "tokenSymbol" TEXT,
    "tokenName" TEXT,
    "myCapitalSOL" DOUBLE PRECISION NOT NULL,
    "trackedCapitalSOL" DOUBLE PRECISION NOT NULL,
    "scalingRatio" DOUBLE PRECISION NOT NULL,
    "requestedAmountSOL" DOUBLE PRECISION NOT NULL,
    "executedAmountSOL" DOUBLE PRECISION,
    "amountTokens" DOUBLE PRECISION,
    "requestedPriceSOL" DOUBLE PRECISION,
    "executedPriceSOL" DOUBLE PRECISION,
    "executedPriceUSD" DOUBLE PRECISION,
    "slippagePct" DOUBLE PRECISION,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "executionMs" INTEGER,
    "entryTradeId" TEXT,
    "pnlSOL" DOUBLE PRECISION,
    "pnlUSD" DOUBLE PRECISION,
    "pnlPct" DOUBLE PRECISION,
    "trackedPnlPct" DOUBLE PRECISION,
    "pnlDeviation" DOUBLE PRECISION,
    "isWin" BOOLEAN,
    "isOpen" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "myCapitalSOL" DOUBLE PRECISION NOT NULL DEFAULT 10.0,
    "maxPositionPct" DOUBLE PRECISION NOT NULL DEFAULT 0.10,
    "minSolReserve" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "maxOpenPositions" INTEGER NOT NULL DEFAULT 10,
    "dailyLossLimitSOL" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "maxSlippageBps" INTEGER NOT NULL DEFAULT 100,
    "maxPriceImpactPct" DOUBLE PRECISION NOT NULL DEFAULT 5.0,
    "isTradingPaused" BOOLEAN NOT NULL DEFAULT false,
    "pauseReason" TEXT,
    "pausedAt" TIMESTAMP(3),
    "notifyOnBuy" BOOLEAN NOT NULL DEFAULT true,
    "notifyOnSell" BOOLEAN NOT NULL DEFAULT true,
    "notifyOnError" BOOLEAN NOT NULL DEFAULT true,
    "notifyDailyReport" BOOLEAN NOT NULL DEFAULT true,
    "dailyReportHourUTC" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_pnl" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "totalTradesExecuted" INTEGER NOT NULL DEFAULT 0,
    "totalWins" INTEGER NOT NULL DEFAULT 0,
    "totalLosses" INTEGER NOT NULL DEFAULT 0,
    "winRatePct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "grossPnLSOL" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "feesSOL" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netPnLSOL" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netPnLUSD" DOUBLE PRECISION,
    "roiPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bestTradeId" TEXT,
    "bestTradePnLSOL" DOUBLE PRECISION,
    "bestTradePnLPct" DOUBLE PRECISION,
    "worstTradeId" TEXT,
    "worstTradePnLSOL" DOUBLE PRECISION,
    "worstTradePnLPct" DOUBLE PRECISION,
    "endingCapitalSOL" DOUBLE PRECISION,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_pnl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_logs" (
    "id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "message" TEXT NOT NULL,
    "tradeId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "errorMsg" TEXT,

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tracked_wallets_address_key" ON "tracked_wallets"("address");

-- CreateIndex
CREATE INDEX "tracked_wallets_address_idx" ON "tracked_wallets"("address");

-- CreateIndex
CREATE INDEX "tracked_wallets_isActive_idx" ON "tracked_wallets"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_trades_txSignature_key" ON "wallet_trades"("txSignature");

-- CreateIndex
CREATE INDEX "wallet_trades_trackedWalletId_idx" ON "wallet_trades"("trackedWalletId");

-- CreateIndex
CREATE INDEX "wallet_trades_txSignature_idx" ON "wallet_trades"("txSignature");

-- CreateIndex
CREATE INDEX "wallet_trades_blockTime_idx" ON "wallet_trades"("blockTime");

-- CreateIndex
CREATE INDEX "wallet_trades_tokenMint_idx" ON "wallet_trades"("tokenMint");

-- CreateIndex
CREATE UNIQUE INDEX "trades_walletTradeId_key" ON "trades"("walletTradeId");

-- CreateIndex
CREATE UNIQUE INDEX "trades_txSignature_key" ON "trades"("txSignature");

-- CreateIndex
CREATE INDEX "trades_trackedWalletId_idx" ON "trades"("trackedWalletId");

-- CreateIndex
CREATE INDEX "trades_tokenMint_idx" ON "trades"("tokenMint");

-- CreateIndex
CREATE INDEX "trades_status_idx" ON "trades"("status");

-- CreateIndex
CREATE INDEX "trades_isOpen_idx" ON "trades"("isOpen");

-- CreateIndex
CREATE INDEX "trades_createdAt_idx" ON "trades"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "daily_pnl_date_key" ON "daily_pnl"("date");

-- CreateIndex
CREATE INDEX "daily_pnl_date_idx" ON "daily_pnl"("date");

-- CreateIndex
CREATE INDEX "notification_logs_type_idx" ON "notification_logs"("type");

-- CreateIndex
CREATE INDEX "notification_logs_sentAt_idx" ON "notification_logs"("sentAt");

-- AddForeignKey
ALTER TABLE "wallet_trades" ADD CONSTRAINT "wallet_trades_trackedWalletId_fkey" FOREIGN KEY ("trackedWalletId") REFERENCES "tracked_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_trackedWalletId_fkey" FOREIGN KEY ("trackedWalletId") REFERENCES "tracked_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_walletTradeId_fkey" FOREIGN KEY ("walletTradeId") REFERENCES "wallet_trades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
