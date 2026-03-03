// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — routes/portfolio.js
// GET /portfolio — live wallet balances + USD values
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { fetchWalletPortfolio } from '../wallet/solana.js';
import { fetchMarketData } from '../market/prices.js';
import { DEFAULT_BASE_PORTFOLIO } from '../agent/portfolio.js';

const router = Router();

const { SOLANA_RPC_URL, WALLET_ADDRESS } = process.env;

export async function getPortfolio() {
  let basePortfolio;
  if (SOLANA_RPC_URL && WALLET_ADDRESS) {
    try {
      basePortfolio = await fetchWalletPortfolio(WALLET_ADDRESS, SOLANA_RPC_URL);
    } catch (err) {
      console.warn('[Mercer] Wallet fetch failed — falling back to mock portfolio.', err.message);
      basePortfolio = DEFAULT_BASE_PORTFOLIO;
    }
  } else {
    basePortfolio = DEFAULT_BASE_PORTFOLIO;
  }

  const symbols = [...new Set([...basePortfolio.holdings.map(h => h.symbol), 'USDC'])];
  const market = await fetchMarketData(symbols);

  const holdings = basePortfolio.holdings.map(h => {
    const price = market[h.symbol]?.price ?? 0;
    const value = price * h.quantity;
    return { token: h.symbol, balance: h.quantity, price, value };
  });

  const holdingsValue = holdings.reduce((sum, h) => sum + h.value, 0);
  const totalValue    = holdingsValue + (basePortfolio.cashUsd ?? 0);

  return { totalValue, change24h: null, holdings };
}

// GET /portfolio
router.get('/', async (req, res, next) => {
  try {
    res.json(await getPortfolio());
  } catch (err) {
    next(err);
  }
});

export default router;
