// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — index.js
// Reasoning loop with live CoinGecko price data + live or mock portfolio
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import { reason, printDecision } from './agent/reasoning.js';
import { MANDATE_PRESETS } from './agent/mandate.js';
import { fetchMarketData } from './market/prices.js';
import { DEFAULT_BASE_PORTFOLIO, buildLivePortfolio } from './agent/portfolio.js';
import { fetchWalletPortfolio } from './wallet/solana.js';

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

  // ── Step 1: Resolve base portfolio (live wallet or mock fallback) ─────────
  const { SOLANA_RPC_URL, WALLET_ADDRESS } = process.env;

  let basePortfolio;
  if (SOLANA_RPC_URL && WALLET_ADDRESS) {
    console.log(`[Mercer] Fetching on-chain balances for ${WALLET_ADDRESS}...`);
    try {
      basePortfolio = await fetchWalletPortfolio(WALLET_ADDRESS, SOLANA_RPC_URL);
      console.log('[Mercer] On-chain balances loaded.\n');
    } catch (err) {
      console.warn('\x1b[33m[Mercer] Wallet fetch failed — falling back to mock portfolio.\x1b[0m', err.message);
      basePortfolio = DEFAULT_BASE_PORTFOLIO;
    }
  } else {
    console.warn('\x1b[33m[Mercer] SOLANA_RPC_URL or WALLET_ADDRESS not set — using mock portfolio.\x1b[0m\n');
    basePortfolio = DEFAULT_BASE_PORTFOLIO;
  }

  // ── Step 2: Fetch live market data from CoinGecko ────────────────────────
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

  // ── Step 3: Patch null entry prices to current market price ──────────────
  // On-chain data has no purchase history; seed entry price = current price
  // so PnL starts at 0% rather than dividing by null.
  if (SOLANA_RPC_URL && WALLET_ADDRESS) {
    basePortfolio = {
      ...basePortfolio,
      holdings: basePortfolio.holdings.map(h => ({
        ...h,
        entryPrice: h.entryPrice ?? market[h.symbol]?.price ?? 0,
      })),
    };
  }

  // ── Step 4: Build live portfolio ──────────────────────────────────────────
  const portfolio = buildLivePortfolio(basePortfolio, market);

  console.log(`Active mandate: \x1b[33m${mandate.riskTier.toUpperCase()}\x1b[0m`);
  console.log(`Portfolio value: \x1b[32m$${portfolio.totalValueUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}\x1b[0m`);
  console.log(`Holdings: ${portfolio.holdings.map(h => `${h.symbol} (${h.pnlPct >= 0 ? '+' : ''}${h.pnlPct.toFixed(2)}%)`).join(', ')}`);

  // ── Step 5: Run reasoning loop ────────────────────────────────────────────
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
