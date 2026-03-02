// Drop this in C:\Users\Andrew\SOL Systems\debug.js
// Run: node debug.js
// It will print exactly which require() is crashing

const modules = [
  ['config',           './src/config'],
  ['logger',           './src/utils/logger'],
  ['calculator',       './src/utils/calculator'],
  ['solana utils',     './src/utils/solana'],
  ['tradeRepository',  './src/execution/tradeRepository'],
  ['positionTracker',  './src/monitor/positionTracker'],
  ['walletMonitor',    './src/monitor/walletMonitor'],
  ['heliusWebhook',    './src/monitor/heliusWebhook'],
  ['transactionParser','./src/monitor/transactionParser'],
  ['jupiterClient',    './src/execution/jupiterClient'],
  ['riskManager',      './src/execution/riskManager'],
  ['tradeExecutor',    './src/execution/tradeExecutor'],
  ['apiServer',        './src/api/server'],
  ['pnlHandler',       './src/telegram/handlers/pnlHandler'],
  ['tradeNotifier',    './src/telegram/handlers/tradeNotifier'],
  ['walletHandler',    './src/telegram/handlers/walletHandler'],
  ['statusHandler',    './src/telegram/handlers/statusHandler'],
  ['dailyReportJob',   './src/telegram/handlers/dailyReportJob'],
  ['telegramBot',      './src/telegram/bot'],
  ['index',            './src/index'],
];

for (const [name, path] of modules) {
  try {
    require(path);
    console.log(`✅  ${name}`);
  } catch (err) {
    console.error(`\n❌  FAILED: ${name}`);
    console.error(`    Path:  ${path}`);
    console.error(`    Error: ${err.message}`);
    if (err.stack) {
      const lines = err.stack.split('\n').slice(1, 4);
      lines.forEach(l => console.error('   ', l.trim()));
    }
    console.error('\n--- Fix this module first, then re-run debug.js ---');
    process.exit(1);
  }
}

console.log('\n✅  All modules load successfully!');