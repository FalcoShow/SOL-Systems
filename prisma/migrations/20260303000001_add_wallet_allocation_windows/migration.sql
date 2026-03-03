-- Add AI allocation and trading window fields to tracked_wallets
-- allocationSOL : the exact SOL budget the AI assigned to this wallet
--                 (NULL = use full settings capital, same as before)
-- trackFrom     : UTC time string "HH:MM" — only copy trades at/after this time
--                 (NULL = copy 24/7, same as before)
-- trackUntil    : UTC time string "HH:MM" — only copy trades before this time
--                 (NULL = copy 24/7, same as before)

ALTER TABLE "tracked_wallets"
  ADD COLUMN "allocationSOL" DOUBLE PRECISION,
  ADD COLUMN "trackFrom"     TEXT,
  ADD COLUMN "trackUntil"    TEXT;

-- Also add confidence field to WalletIntelligence for the report summary
ALTER TABLE "wallet_intelligence"
  ADD COLUMN "confidence" INTEGER NOT NULL DEFAULT 0;
