// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — routes/market.js
// GET /market?symbols=SOL,JUP,BONK
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { fetchMarketData } from '../market/coingecko.js';

const router = Router();

const DEFAULT_SYMBOLS = ['SOL', 'JUP', 'BONK', 'WIF', 'USDC', 'JTO', 'PYTH'];

router.get('/', async (req, res, next) => {
  try {
    const symbols = req.query.symbols
      ? req.query.symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
      : DEFAULT_SYMBOLS;

    let market;
    try {
      market = await fetchMarketData(symbols);
    } catch (err) {
      return next(Object.assign(new Error(err.message), { status: 400 }));
    }

    res.json(market);
  } catch (err) {
    next(err);
  }
});

export default router;
