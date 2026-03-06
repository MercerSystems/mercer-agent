// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — routes/reason.js
// POST /reason — run a full reasoning cycle with live market data
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { reason } from '../agent/reasoning.js';
import { MANDATE_PRESETS } from '../agent/mandate.js';
import { fetchMarketData } from '../market/prices.js';
import { DEFAULT_BASE_PORTFOLIO, buildLivePortfolio } from '../agent/portfolio.js';
import { fetchWalletPortfolio } from '../wallet/solana.js';
import { recordCycle } from './stats.js';
import { executeDecision } from '../executor.js';
import { recordSnapshot } from '../history.js';

const { SOLANA_RPC_URL, WALLET_ADDRESS } = process.env;

// Tracks the last time trades were actually executed (auto or manual)
let lastExecutionAt = null;

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

    // Resolve base portfolio: caller-supplied > live wallet > mock fallback
    let basePortfolio;
    if (portfolioInput) {
      basePortfolio = portfolioInput;
    } else if (SOLANA_RPC_URL && WALLET_ADDRESS) {
      try {
        basePortfolio = await fetchWalletPortfolio(WALLET_ADDRESS, SOLANA_RPC_URL);
      } catch (err) {
        console.warn('[Mercer] Wallet fetch failed — falling back to mock portfolio.', err.message);
        basePortfolio = DEFAULT_BASE_PORTFOLIO;
      }
    } else {
      basePortfolio = DEFAULT_BASE_PORTFOLIO;
    }

    // Extract unique symbols from holdings + USDC
    const symbols = [...new Set([...basePortfolio.holdings.map(h => h.symbol), 'USDC'])];

    // Fetch live market data
    let market;
    try {
      market = await fetchMarketData(symbols);
    } catch (err) {
      return next(Object.assign(new Error(err.message), { status: 400 }));
    }

    // Seed null entry prices to current price so PnL starts at 0% for live wallet holdings
    if (!portfolioInput && SOLANA_RPC_URL && WALLET_ADDRESS) {
      basePortfolio = {
        ...basePortfolio,
        holdings: basePortfolio.holdings.map(h => ({
          ...h,
          entryPrice: h.entryPrice ?? market[h.symbol]?.price ?? 0,
        })),
      };
    }

    // Build enriched portfolio
    const livePortfolio = buildLivePortfolio(basePortfolio, market);
    recordSnapshot(livePortfolio.totalValueUsd);

    // Run reasoning loop
    const cycleStart = Date.now();
    const { decision, violations, blocked, usage } = await reason({
      portfolio: livePortfolio,
      market,
      mandate,
      trigger,
    });
    recordCycle(Date.now() - cycleStart);

    // ── Always log the decision outcome ──────────────────────────────────────
    console.log(`[Mercer] Decision: ${decision.action} — confidence: ${decision.confidence ?? 'n/a'}`);

    // ── Auto-execute (or dry-run) ─────────────────────────────────────────────
    let execution = null;

    if (!blocked) {
      const autoExecute      = process.env.AUTO_EXECUTE === 'true';
      const minIntervalSec   = parseInt(process.env.MIN_CYCLE_INTERVAL, 10) || 300;
      const secSinceLast     = lastExecutionAt ? (Date.now() - lastExecutionAt) / 1000 : Infinity;
      const throttled        = autoExecute && secSinceLast < minIntervalSec;

      if (autoExecute && !throttled && decision.action !== 'hold') {
        const tradeDesc = decision.trades?.map(t => `${t.asset} ${t.type} $${t.amountUsd}`).join(', ') || decision.action;
        console.log(`[Mercer] Auto-executing: ${decision.action} — ${tradeDesc}`);
        execution = await executeDecision(decision, market);
        if (execution?.trades?.some(t => t.status === 'executed' || t.status === 'dry_run')) {
          lastExecutionAt = Date.now();
        }
      } else if (throttled) {
        console.log(`[Mercer] Throttled — ${Math.round(secSinceLast)}s since last trade (min: ${minIntervalSec}s)`);
        execution = { status: 'throttled', secSinceLast: Math.round(secSinceLast), minIntervalSec };
      } else if (decision.action === 'hold') {
        console.log(`[Mercer] Hold — no execution needed`);
        execution = await executeDecision(decision, market);
      } else {
        // AUTO_EXECUTE off — still dry-run for logging
        execution = await executeDecision(decision, market);
      }
    }

    res.json({ decision, violations, blocked, usage, execution });
  } catch (err) {
    next(err);
  }
});

export default router;
