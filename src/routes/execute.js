// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — routes/execute.js
// POST /execute — manually trigger a full reason + swap execution cycle
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { reason } from '../agent/reasoning.js';
import { MANDATE_PRESETS } from '../agent/mandate.js';
import { fetchSolanaMarketMap } from '../market/solana-market.js';
import { DEFAULT_BASE_PORTFOLIO, buildLivePortfolio } from '../agent/portfolio.js';
import { fetchWalletPortfolio } from '../wallet/solana.js';
import { executeDecision } from '../executor.js';

const router = Router();

const { SOLANA_RPC_URL, WALLET_ADDRESS } = process.env;

function resolveMandate(mandate) {
  if (typeof mandate === 'string') return MANDATE_PRESETS[mandate] ?? null;
  return mandate ?? null;
}

// POST /execute
router.post('/', async (req, res, next) => {
  try {
    const {
      mandate: mandateInput = 'moderate',
      trigger = 'manual_execute',
    } = req.body ?? {};

    const mandate = resolveMandate(mandateInput);
    if (!mandate) {
      return next(Object.assign(
        new Error(`Unknown mandate preset: "${mandateInput}". Valid presets: ${Object.keys(MANDATE_PRESETS).join(', ')}`),
        { status: 400 }
      ));
    }

    // ── Resolve live portfolio ───────────────────────────────────────────────
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

    // ── Fetch market data ────────────────────────────────────────────────────
    const market = await fetchSolanaMarketMap(150);

    // Seed null entry prices for live wallet holdings
    if (SOLANA_RPC_URL && WALLET_ADDRESS) {
      basePortfolio = {
        ...basePortfolio,
        holdings: basePortfolio.holdings.map(h => ({
          ...h,
          entryPrice: h.entryPrice ?? market[h.symbol]?.price ?? 0,
        })),
      };
    }

    // ── Reason ───────────────────────────────────────────────────────────────
    const livePortfolio = buildLivePortfolio(basePortfolio, market);
    const { decision, violations, blocked, usage } = await reason({
      portfolio: livePortfolio,
      market,
      mandate,
      trigger,
    });

    // ── Execute ──────────────────────────────────────────────────────────────
    const execution = blocked ? null : await executeDecision(decision, market);

    // Update decision status if trades were executed
    if (execution?.trades) {
      decision.trades = execution.trades;
      if (execution.status === 'executed') decision.status = 'executed';
    }

    res.json({ decision, violations, blocked, usage, execution });
  } catch (err) {
    next(err);
  }
});

export default router;
