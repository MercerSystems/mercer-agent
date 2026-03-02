// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — index.js
// Reasoning loop with live CoinGecko price data + mock portfolio positions
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import { reason, printDecision } from './agent/reasoning.js';
import { MANDATE_PRESETS } from './agent/mandate.js';
import { fetchMarketData } from './market/coingecko.js';

// ── Base Portfolio State ───────────────────────────────────────────────────────
// Quantities and entry prices are fixed (would come from on-chain wallet in prod).
// Current prices, valueUsd, and pnlPct are recalculated from live Jupiter data.

const basePortfolio = {
  walletAddress: 'MockWallet1111111111111111111111111111111111',
  peakValueUsd: 0,       // Reset — recalculated from live prices on first run
  cashUsd: 5_000,        // Uninvested USDC
  holdings: [
    { symbol: 'SOL',  quantity: 149.33,      entryPrice: 81.46      },
    { symbol: 'JUP',  quantity: 11_150,      entryPrice: 0.152383   },
    { symbol: 'BONK', quantity: 310_000_000, entryPrice: 0.00000591 },
    { symbol: 'WIF',  quantity: 1_920,       entryPrice: 0.200653   },
  ],
};

// ── Live Portfolio Builder ────────────────────────────────────────────────────
// Applies live CoinGecko prices to recalculate position values and PnL.

function buildLivePortfolio(base, market) {
  const holdings = base.holdings.map((h) => {
    const currentPrice = market[h.symbol]?.price ?? h.entryPrice;
    const valueUsd     = currentPrice * h.quantity;
    const pnlPct       = ((currentPrice - h.entryPrice) / h.entryPrice) * 100;
    return { ...h, currentPrice, valueUsd, pnlPct };
  });

  const totalValueUsd = holdings.reduce((sum, h) => sum + h.valueUsd, 0) + base.cashUsd;

  // Seed peak from current value if not set, so drawdown starts at 0%
  const peakValueUsd = base.peakValueUsd > 0 ? base.peakValueUsd : totalValueUsd;

  return { ...base, holdings, totalValueUsd, peakValueUsd };
}

// ── Active Mandate ────────────────────────────────────────────────────────────
// Switch to 'conservative' or 'aggressive' to see different behavior.

const activeMandatePreset = 'moderate';
const mandate = MANDATE_PRESETS[activeMandatePreset];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\x1b[1m\x1b[36m');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║        MERCER SYSTEMS — v0.1.0           ║');
  console.log('║   Autonomous DeFi Portfolio Agent        ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('\x1b[0m');

  // ── Step 1: Fetch live market data from CoinGecko ────────────────────────
  console.log('[Mercer] Fetching live prices from CoinGecko...');
  const symbols = [...basePortfolio.holdings.map(h => h.symbol), 'USDC'];

  let market;
  try {
    market = await fetchMarketData(symbols);
    console.log(`[Mercer] Live prices loaded: ${Object.keys(market).join(', ')}\n`);
  } catch (err) {
    console.error('\x1b[31m[CoinGecko Error]\x1b[0m', err.message);
    process.exit(1);
  }

  // Print live prices
  for (const [symbol, data] of Object.entries(market)) {
    const changeStr = data.change24h != null
      ? (data.change24h >= 0
          ? ` \x1b[32m+${data.change24h.toFixed(2)}%\x1b[0m`
          : ` \x1b[31m${data.change24h.toFixed(2)}%\x1b[0m`)
      : '';
    console.log(`  ${symbol.padEnd(5)} \x1b[32m$${data.price.toLocaleString(undefined, { maximumFractionDigits: 8 })}\x1b[0m${changeStr}`);
  }
  console.log();

  // ── Step 2: Build live portfolio ──────────────────────────────────────────
  const portfolio = buildLivePortfolio(basePortfolio, market);

  console.log(`Active mandate: \x1b[33m${mandate.riskTier.toUpperCase()}\x1b[0m`);
  console.log(`Portfolio value: \x1b[32m$${portfolio.totalValueUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}\x1b[0m`);
  console.log(`Holdings: ${portfolio.holdings.map(h => `${h.symbol} (${h.pnlPct >= 0 ? '+' : ''}${h.pnlPct.toFixed(2)}%)`).join(', ')}`);

  // ── Step 3: Run reasoning loop ────────────────────────────────────────────
  try {
    const result = await reason({
      portfolio,
      market,
      mandate,
      trigger: 'live_market_data',
    });

    printDecision(result);

    console.log('\x1b[2mRaw decision (pre-mandate enforcement):\x1b[0m');
    console.log('\x1b[2m' + result.raw + '\x1b[0m\n');

  } catch (err) {
    console.error('\n\x1b[31m[Mercer Error]\x1b[0m', err.message);
    if (err.message.includes('ANTHROPIC_API_KEY')) {
      console.error('\nSet your API key in .env:');
      console.error('  ANTHROPIC_API_KEY=sk-ant-...\n');
    }
    process.exit(1);
  }
}

main();
