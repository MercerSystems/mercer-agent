// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — routes/reason.js
// POST /reason — run a full reasoning cycle with live market data
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { reason } from '../agent/reasoning.js';
import { MANDATE_PRESETS } from '../agent/mandate.js';
import { fetchMarketData } from '../market/coingecko.js';
import { DEFAULT_BASE_PORTFOLIO, buildLivePortfolio } from '../agent/portfolio.js';

const router = Router();

/**
 * Resolves a mandate from a string preset name or a full mandate object.
 * Returns null if a string preset name is unknown.
 */
function resolveMandate(mandate) {
  if (typeof mandate === 'string') {
    return MANDATE_PRESETS[mandate] ?? null;
  }
  return mandate ?? null;
}

// POST /reason
router.post('/', async (req, res, next) => {
  try {
    const {
      portfolio: portfolioInput,
      mandate: mandateInput = 'moderate',
      trigger = 'api_call',
    } = req.body ?? {};

    // Resolve mandate
    const mandate = resolveMandate(mandateInput);
    if (!mandate) {
      return next(Object.assign(
        new Error(`Unknown mandate preset: "${mandateInput}". Valid presets: ${Object.keys(MANDATE_PRESETS).join(', ')}`),
        { status: 400 }
      ));
    }

    // Default portfolio
    const basePortfolio = portfolioInput ?? DEFAULT_BASE_PORTFOLIO;

    // Extract unique symbols from holdings + USDC
    const symbols = [...new Set([...basePortfolio.holdings.map(h => h.symbol), 'USDC'])];

    // Fetch live market data
    let market;
    try {
      market = await fetchMarketData(symbols);
    } catch (err) {
      return next(Object.assign(new Error(err.message), { status: 400 }));
    }

    // Build enriched portfolio
    const livePortfolio = buildLivePortfolio(basePortfolio, market);

    // Run reasoning loop
    const { decision, violations, blocked, usage } = await reason({
      portfolio: livePortfolio,
      market,
      mandate,
      trigger,
    });

    res.json({ decision, violations, blocked, usage });
  } catch (err) {
    next(err);
  }
});

export default router;
