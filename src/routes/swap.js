// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — routes/swap.js
// GET  /swap/quote?from=SOL&to=USDC&amount=10
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { getSwapQuote, MINTS, DECIMALS, toRawAmount } from '../swap/jupiter.js';

const router = Router();

// GET /swap/quote?from=SOL&to=USDC&amount=10
router.get('/quote', async (req, res, next) => {
  try {
    const { from, to, amount } = req.query;

    if (!from || !to || !amount) {
      return next(Object.assign(
        new Error('Required query params: from, to, amount  (e.g. ?from=SOL&to=USDC&amount=10)'),
        { status: 400 }
      ));
    }

    const fromSymbol = from.toUpperCase();
    const toSymbol   = to.toUpperCase();

    if (!MINTS[fromSymbol]) {
      return next(Object.assign(new Error(`Unsupported token: ${from}`), { status: 400 }));
    }
    if (!MINTS[toSymbol]) {
      return next(Object.assign(new Error(`Unsupported token: ${to}`), { status: 400 }));
    }

    const humanAmount = parseFloat(amount);
    if (isNaN(humanAmount) || humanAmount <= 0) {
      return next(Object.assign(new Error('amount must be a positive number'), { status: 400 }));
    }

    const rawAmount = toRawAmount(humanAmount, DECIMALS[fromSymbol]);
    const quote     = await getSwapQuote(MINTS[fromSymbol], MINTS[toSymbol], rawAmount);

    res.json(quote);
  } catch (err) {
    next(err);
  }
});

export default router;
