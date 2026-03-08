// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — routes/portfolio.js
// GET /portfolio — live wallet balances + USD values
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { fetchWalletPortfolio } from '../wallet/solana.js';
import { fetchSolanaMarketMap, fetchPricesByMint } from '../market/solana-market.js';
import { fetchNewLaunches } from '../market/dexscreener.js';
import { DEFAULT_BASE_PORTFOLIO } from '../agent/portfolio.js';
import { recordSnapshot, getHistory } from '../history.js';

const router = Router();

const { SOLANA_RPC_URL, WALLET_ADDRESS } = process.env;

export async function getPortfolio() {
  let basePortfolio;
  let source = 'mock';
  if (SOLANA_RPC_URL && WALLET_ADDRESS) {
    try {
      basePortfolio = await fetchWalletPortfolio(WALLET_ADDRESS, SOLANA_RPC_URL);
      source = 'live';
    } catch (err) {
      console.warn('[Mercer] Wallet fetch failed — falling back to mock portfolio.', err.message);
      basePortfolio = DEFAULT_BASE_PORTFOLIO;
    }
  } else {
    basePortfolio = DEFAULT_BASE_PORTFOLIO;
  }

  const [market, dexLaunches] = await Promise.all([
    fetchSolanaMarketMap(150),
    fetchNewLaunches().catch(() => ({})),
  ]);
  // Merge DexScreener launches — prices brand-new pump.fun tokens CoinGecko doesn't list yet
  for (const [sym, entry] of Object.entries(dexLaunches)) {
    if (!market[sym]) market[sym] = entry;
  }

  const holdings = basePortfolio.holdings.map(h => {
    const sym       = h.symbol;
    const mkt       = sym ? market[sym] : null;
    const price     = mkt?.price ?? 0;
    const change24h = mkt?.change24h ?? null;
    const value     = price * h.quantity;
    return { token: sym, balance: h.quantity, price, change24h, value, _mint: h.mint, _unknown: h.unknown };
  });

  // Auto-price any holding with price=0 using CoinGecko's mint-based endpoint.
  // This handles tokens not in the ecosystem map (new buys, unlisted tokens, etc.)
  const needsPrice = holdings.filter(h => h.price === 0 && h._mint);
  if (needsPrice.length > 0) {
    const mintPrices = await fetchPricesByMint(needsPrice.map(h => h._mint));
    for (const h of needsPrice) {
      const p = mintPrices[h._mint];
      if (!p) continue;
      h.price      = p.usd ?? 0;
      h.value      = h.price * h.balance;
      h.change24h  = p.usd_24h_change ?? null;
      // If symbol was unknown, label with truncated mint so it shows in dashboard
      if (!h.token && h._mint) h.token = h._mint.slice(0, 6) + '…';
    }
  }

  // Strip internal fields before returning
  for (const h of holdings) { delete h._mint; delete h._unknown; }

  // Filter out any holding that still has no price and no recognised symbol
  const pricedHoldings = holdings.filter(h => h.token && (h.value >= 0.01 || h.token === 'USDC'));

  const holdingsValue = pricedHoldings.reduce((sum, h) => sum + h.value, 0);
  const totalValue    = holdingsValue + (basePortfolio.cashUsd ?? 0);

  recordSnapshot(totalValue);
  return { totalValue, change24h: null, holdings: pricedHoldings, source };
}

// GET /portfolio
router.get('/', async (req, res, next) => {
  try {
    res.json(await getPortfolio());
  } catch (err) {
    next(err);
  }
});

// GET /portfolio/history
router.get('/history', (_req, res) => {
  res.json(getHistory());
});

export default router;
