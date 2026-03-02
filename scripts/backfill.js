// ============================================================
//  SOL SYSTEMS — Historical Trade Backfill
//  File: scripts/backfill.js
//
//  One-time utility script. Run this when you first add a
//  tracked wallet to pre-populate its trade history so the
//  Analytics page and capital estimator have real data.
//
//  Usage:
//    node scripts/backfill.js --wallet <ADDRESS> [--days 30]
//    node scripts/backfill.js --wallet <ADDRESS> --days 90
//    node scripts/backfill.js --all --days 30
//
//  What it does:
//    1. Fetches the wallet's transaction history from Helius
//    2. Parses each transaction to find swap events
//    3. Skips any swap already recorded in the database
//    4. Inserts historical WalletTrade records
//    5. Re-runs the walletSync capital estimator
//    6. Prints a summary of what was imported
//
//  Safe to run multiple times — uses upsert so it never
//  creates duplicate records.
// ============================================================

'use strict';

require('dotenv').config();

const axios          = require('axios');
const { PrismaClient } = require('@prisma/client');

const prisma         = new PrismaClient();
const logger         = require('../src/utils/logger');
const { estimateWalletCapital } = require('../src/utils/calculator');

// ── CLI argument parsing ─────────────────────────────────────
const args = process.argv.slice(2);

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
}

const TARGET_WALLET = getArg('--wallet');
const BACKFILL_ALL  = args.includes('--all');
const DAYS          = parseInt(getArg('--days') || '30');
const DRY_RUN       = args.includes('--dry-run');

if (!TARGET_WALLET && !BACKFILL_ALL) {
  console.error('Usage:');
  console.error('  node scripts/backfill.js --wallet <SOLANA_ADDRESS> [--days 30]');
  console.error('  node scripts/backfill.js --all [--days 30]');
  console.error('  node scripts/backfill.js --wallet <ADDRESS> --dry-run');
  process.exit(1);
}

// ── Config ───────────────────────────────────────────────────
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_URL     = `https://api.helius.xyz/v0`;
const BATCH_SIZE     = 100;    // Helius max per page
const RATE_LIMIT_MS  = 250;    // Wait between API calls to avoid rate limiting

// ────────────────────────────────────────────────────────────
//  MAIN
// ────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔄 SOL Systems — Historical Trade Backfill');
  console.log('═══════════════════════════════════════════\n');

  if (!HELIUS_API_KEY) {
    console.error('❌ HELIUS_API_KEY is not set in .env');
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('🔍 DRY RUN — no data will be written\n');
  }

  // Determine which wallets to backfill
  let wallets = [];

  if (BACKFILL_ALL) {
    const dbWallets = await prisma.trackedWallet.findMany({ where: { isActive: true } });
    wallets = dbWallets.map(w => ({ address: w.address, nickname: w.nickname }));
    console.log(`📋 Backfilling ${wallets.length} active tracked wallets\n`);
  } else {
    // Check if wallet exists in DB
    const dbWallet = await prisma.trackedWallet.findUnique({
      where: { address: TARGET_WALLET },
    });
    if (!dbWallet) {
      console.error(`❌ Wallet ${TARGET_WALLET} is not in the database.`);
      console.error('   Add it first via Telegram /addwallet or the dashboard.');
      process.exit(1);
    }
    wallets = [{ address: TARGET_WALLET, nickname: dbWallet.nickname }];
  }

  // Backfill each wallet
  const results = [];
  for (const wallet of wallets) {
    console.log(`\n🔎 Processing: ${wallet.nickname} (${wallet.address})`);
    const result = await backfillWallet(wallet.address, wallet.nickname);
    results.push({ wallet: wallet.nickname, ...result });
  }

  // Summary
  console.log('\n\n📊 BACKFILL SUMMARY');
  console.log('═══════════════════');
  for (const r of results) {
    const status = r.error ? '❌' : '✅';
    console.log(`${status} ${r.wallet}`);
    if (r.error) {
      console.log(`   Error: ${r.error}`);
    } else {
      console.log(`   Transactions fetched: ${r.txFetched}`);
      console.log(`   Swaps found:          ${r.swapsFound}`);
      console.log(`   New records inserted: ${r.inserted}`);
      console.log(`   Already existed:      ${r.skipped}`);
    }
  }

  console.log('\n✅ Backfill complete\n');
  await prisma.$disconnect();
}

// ────────────────────────────────────────────────────────────
//  PER-WALLET BACKFILL
// ────────────────────────────────────────────────────────────

async function backfillWallet(address, nickname) {
  const result = {
    txFetched:  0,
    swapsFound: 0,
    inserted:   0,
    skipped:    0,
    error:      null,
  };

  try {
    const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
    console.log(`   Fetching ${DAYS} days of history since ${since.toISOString().slice(0, 10)}...`);

    // ── Fetch transaction history from Helius ────────────
    const transactions = await fetchHeliusTransactions(address, since);
    result.txFetched = transactions.length;
    console.log(`   Found ${transactions.length} transactions`);

    // ── Filter for swap events ────────────────────────────
    const swaps = transactions.filter(isSwapTransaction);
    result.swapsFound = swaps.length;
    console.log(`   Found ${swaps.length} swap events`);

    if (swaps.length === 0) {
      console.log('   Nothing to import');
      return result;
    }

    // ── Insert into WalletTrade table ─────────────────────
    for (const tx of swaps) {
      const parsed = parseSwapTransaction(tx, address);
      if (!parsed) continue;

      if (DRY_RUN) {
        console.log(`   [DRY] Would insert: ${parsed.type} ${parsed.tokenSymbol || parsed.tokenMint.slice(0, 8)} ${parsed.amountSOL?.toFixed(4)} SOL`);
        result.inserted++;
        continue;
      }

      try {
        // Upsert — safe to re-run
        await prisma.walletTrade.upsert({
          where:  { txSignature: parsed.txSignature },
          create: {
            walletAddress: address,
            txSignature:   parsed.txSignature,
            type:          parsed.type,
            tokenMint:     parsed.tokenMint,
            tokenSymbol:   parsed.tokenSymbol || null,
            amountSOL:     parsed.amountSOL,
            tokenAmount:   parsed.tokenAmount || null,
            priceSOL:      parsed.priceSOL   || null,
            detectedAt:    new Date(parsed.timestamp * 1000),
            blockTime:     parsed.timestamp,
          },
          update: {}, // If it exists, leave it — don't overwrite
        });
        result.inserted++;
      } catch (err) {
        if (err.code === 'P2002') {
          result.skipped++; // Unique constraint — already exists
        } else {
          logger.warn('Failed to insert wallet trade', {
            tx:    parsed.txSignature,
            error: err.message,
          });
        }
      }

      // Rate limiting
      await sleep(50);
    }

    console.log(`   ✅ Inserted: ${result.inserted}  Skipped: ${result.skipped}`);

    // ── Re-estimate capital from backfilled data ──────────
    if (!DRY_RUN && result.inserted > 0) {
      await reEstimateCapital(address, nickname);
    }

  } catch (err) {
    result.error = err.message;
    console.error(`   ❌ Error: ${err.message}`);
  }

  return result;
}

// ────────────────────────────────────────────────────────────
//  HELIUS API — Fetch enhanced transaction history
// ────────────────────────────────────────────────────────────

async function fetchHeliusTransactions(address, since) {
  const allTx   = [];
  let   before  = undefined;  // cursor for pagination
  let   page    = 1;

  while (true) {
    const params = {
      api_key: HELIUS_API_KEY,
      limit:   BATCH_SIZE,
    };
    if (before) params.before = before;

    const url = `${HELIUS_URL}/addresses/${address}/transactions`;

    const response = await axios.get(url, { params, timeout: 15000 });
    const txs      = response.data || [];

    if (txs.length === 0) break;

    // Filter by timestamp — stop when we've gone past our window
    const inWindow = txs.filter(tx => {
      const ts = tx.timestamp || tx.blockTime;
      return ts && new Date(ts * 1000) >= since;
    });

    allTx.push(...inWindow);

    // If we got fewer results than requested, or all remaining
    // are older than our window, stop paginating
    const oldest = txs[txs.length - 1];
    const oldestTs = oldest?.timestamp || oldest?.blockTime;

    if (txs.length < BATCH_SIZE || (oldestTs && new Date(oldestTs * 1000) < since)) {
      break;
    }

    // Cursor for next page
    before = txs[txs.length - 1].signature;
    page++;

    process.stdout.write(`\r   Fetching page ${page}... (${allTx.length} so far)`);
    await sleep(RATE_LIMIT_MS);
  }

  if (allTx.length > 0) process.stdout.write('\n');
  return allTx;
}

// ────────────────────────────────────────────────────────────
//  TRANSACTION PARSING
// ────────────────────────────────────────────────────────────

function isSwapTransaction(tx) {
  // Helius enhanced transactions have a type field
  if (tx.type === 'SWAP') return true;

  // Also catch Jupiter-routed swaps that may have type UNKNOWN
  const desc = (tx.description || '').toLowerCase();
  if (desc.includes('swap') || desc.includes('bought') || desc.includes('sold')) return true;

  // Check for known DEX program IDs in account keys
  const JUPITER_PROGRAM = 'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB';
  const accounts = tx.accountData?.map(a => a.account) || [];
  if (accounts.includes(JUPITER_PROGRAM)) return true;

  return false;
}

function parseSwapTransaction(tx, walletAddress) {
  try {
    const sig       = tx.signature;
    const timestamp = tx.timestamp || tx.blockTime;

    if (!sig || !timestamp) return null;

    // Try to extract swap details from Helius token transfers
    const tokenTransfers = tx.tokenTransfers || [];
    const nativeTransfers = tx.nativeTransfers || [];

    // Find the SOL amount sent/received by this wallet
    const solOut = nativeTransfers
      .filter(t => t.fromUserAccount === walletAddress)
      .reduce((s, t) => s + (t.amount || 0), 0) / 1e9;

    const solIn = nativeTransfers
      .filter(t => t.toUserAccount === walletAddress)
      .reduce((s, t) => s + (t.amount || 0), 0) / 1e9;

    // Find the token received/sent
    const tokenReceived = tokenTransfers.find(t => t.toUserAccount === walletAddress);
    const tokenSent     = tokenTransfers.find(t => t.fromUserAccount === walletAddress);

    const isBuy  = solOut > 0.001 && tokenReceived;
    const isSell = solIn  > 0.001 && tokenSent;

    if (!isBuy && !isSell) return null;

    const token      = isBuy ? tokenReceived : tokenSent;
    const amountSOL  = isBuy ? solOut : solIn;
    const tokenAmount = token ? (token.tokenAmount || 0) : 0;
    const priceSOL    = tokenAmount > 0 ? amountSOL / tokenAmount : 0;

    return {
      txSignature: sig,
      timestamp,
      type:        isBuy ? 'BUY' : 'SELL',
      tokenMint:   token?.mint || 'unknown',
      tokenSymbol: token?.symbol || null,
      amountSOL:   parseFloat(amountSOL.toFixed(9)),
      tokenAmount: parseFloat(tokenAmount.toString()),
      priceSOL:    parseFloat(priceSOL.toFixed(12)),
    };

  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────
//  CAPITAL RE-ESTIMATION
// ────────────────────────────────────────────────────────────

async function reEstimateCapital(address, nickname) {
  try {
    // Pull recent BUY trades from DB (just inserted)
    const walletTrades = await prisma.walletTrade.findMany({
      where:   { walletAddress: address, type: 'BUY' },
      orderBy: { detectedAt: 'desc' },
      take:    50,
    });

    const tradeSample = walletTrades.map(t => ({
      tradeType: 'BUY',
      amountSOL: t.amountSOL || 0,
    })).filter(t => t.amountSOL > 0);

    if (tradeSample.length < 3) return;

    const estimate = estimateWalletCapital(tradeSample);
    if (estimate.estimatedCapitalSOL > 0 && estimate.confidence !== 'none') {
      await prisma.trackedWallet.update({
        where: { address },
        data:  { estimatedCapitalSOL: estimate.estimatedCapitalSOL },
      });
      console.log(`   💰 Capital re-estimated: ~${estimate.estimatedCapitalSOL.toFixed(1)} SOL (${estimate.confidence} confidence)`);
    }
  } catch (err) {
    // Non-fatal
    console.warn(`   ⚠️  Capital re-estimation failed: ${err.message}`);
  }
}

// ────────────────────────────────────────────────────────────
//  HELPERS
// ────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ────────────────────────────────────────────────────────────
//  RUN
// ────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('\n❌ Fatal error:', err.message);
  prisma.$disconnect();
  process.exit(1);
});