// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — routes/market.js
// GET /market?symbols=SOL,JUP,BONK
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { fetchSolanaMarketMap } from '../market/solana-market.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    // Returns the full ecosystem map (served from cache, no extra CoinGecko call).
    // If ?symbols= is provided, filters the response to those symbols only.
    const market = await fetchSolanaMarketMap(150);

    const symbolFilter = req.query.symbols
      ? new Set(req.query.symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean))
      : null;

    const result = symbolFilter
      ? Object.fromEntries(Object.entries(market).filter(([s]) => symbolFilter.has(s)))
      : market;

    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
