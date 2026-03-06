// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — routes/portfolio.js
// GET /portfolio — live wallet balances + USD values
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { fetchWalletPortfolio } from '../wallet/solana.js';
import { fetchSolanaMarketMap } from '../market/solana-market.js';
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

  const market = await fetchSolanaMarketMap(150);

  const holdings = basePortfolio.holdings.map(h => {
    const price = market[h.symbol]?.price ?? 0;
    const value = price * h.quantity;
    return { token: h.symbol, balance: h.quantity, price, value };
  });

  const holdingsValue = holdings.reduce((sum, h) => sum + h.value, 0);
  const totalValue    = holdingsValue + (basePortfolio.cashUsd ?? 0);

  recordSnapshot(totalValue);
  return { totalValue, change24h: null, holdings, source };
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
