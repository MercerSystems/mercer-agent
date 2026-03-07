// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — routes/reason.js
// POST /reason — run a full reasoning cycle with live market data
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { reason, recordDecision } from '../agent/reasoning.js';
import { MANDATE_PRESETS, enforceMandate, scanStopLosses, scanTakeProfits } from '../agent/mandate.js';
import { loadTrailingData, saveTrailingData, updateHighWaterMarks, scanTrailingStops, scanProfitLadder, clearSymbolState } from '../agent/trailing-stops.js';
import { fetchSolanaMarketMap } from '../market/solana-market.js';
import { DEFAULT_BASE_PORTFOLIO, buildLivePortfolio } from '../agent/portfolio.js';
import { fetchWalletPortfolio } from '../wallet/solana.js';
import { loadEntryPrices, saveEntryPrices, applyEntryPrices, loadPeakValue, savePeakValue } from '../agent/entry-prices.js';
import { recordCycle } from './stats.js';
import { executeDecision } from '../executor.js';
import { recordSnapshot } from '../history.js';
import { sendAlert, stopLossAlertText, takeProfitAlertText, tradeAlertText } from '../notify.js';
import { getActiveCooldowns } from '../agent/stop-cooldown.js';

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

    // Fetch the top 150 Solana ecosystem tokens dynamically — no hardcoded list.
    // Claude sees the full market and picks the best opportunities.
    let market;
    try {
      market = await fetchSolanaMarketMap(150);
      // USDC is always included by fetchSolanaMarketMap (never filtered as stablecoin)
    } catch (err) {
      return next(Object.assign(new Error(err.message), { status: 400 }));
    }

    // Apply persisted entry prices — prevents PnL resetting to 0% on every cycle
    if (!portfolioInput) {
      const persisted = loadEntryPrices();
      const { holdings: enrichedHoldings, updated } = applyEntryPrices(basePortfolio.holdings, market, persisted);
      basePortfolio = { ...basePortfolio, holdings: enrichedHoldings };
      saveEntryPrices(updated);

      // Restore persisted peak value so drawdown protection survives restarts
      const storedPeak = loadPeakValue();
      if (storedPeak > 0) basePortfolio = { ...basePortfolio, peakValueUsd: storedPeak };
    }

    // Build enriched portfolio
    const livePortfolio = buildLivePortfolio(basePortfolio, market);

    // Keep peak value up to date on disk
    if (!portfolioInput && livePortfolio.totalValueUsd > livePortfolio.peakValueUsd) {
      savePeakValue(livePortfolio.totalValueUsd);
    } else if (!portfolioInput && livePortfolio.peakValueUsd > 0) {
      savePeakValue(livePortfolio.peakValueUsd);
    }
    recordSnapshot(livePortfolio.totalValueUsd);

    // ── Update trailing stop high-water marks ────────────────────────────────
    let trailingData = loadTrailingData();
    trailingData = updateHighWaterMarks(livePortfolio.holdings, market, trailingData);

    // ── Pre-flight stop-loss check — bypass Claude if thresholds are breached ──
    const triggeredStopLosses = scanStopLosses(livePortfolio, mandate);
    if (triggeredStopLosses.length > 0) {
      console.warn(`[Mercer] Stop-loss bypass triggered: ${triggeredStopLosses.join('; ')}`);

      const stopLossTrades = livePortfolio.holdings
        .filter(h => h.pnlPct <= -mandate.stopLossPct)
        .map(h => ({
          type:      'sell',
          asset:     h.symbol,
          amountUsd: h.valueUsd,
          reason:    `Mandatory stop-loss exit: ${h.pnlPct.toFixed(2)}% PnL breached -${mandate.stopLossPct}% threshold`,
        }));

      const rawDecision = {
        action:     'sell',
        rationale:  `Stop-loss threshold breached for: ${triggeredStopLosses.join(', ')}. Bypassing reasoning cycle — executing mandatory exits immediately.`,
        trades:     stopLossTrades,
        riskFlags:  triggeredStopLosses.map(s => `STOP-LOSS: ${s}`),
        confidence: 1.0,
      };

      const { decision, violations, blocked } = enforceMandate(rawDecision, mandate, livePortfolio, market);
      recordDecision(decision, blocked);

      const execution = await executeDecision(decision, market);
      if (execution?.trades?.some(t => t.status === 'executed' || t.status === 'dry_run')) {
        lastExecutionAt = Date.now();
        const syms = triggeredStopLosses.map(s => s.split(':')[0]);
        syms.forEach(s => { trailingData = clearSymbolState(trailingData, s); });
        saveTrailingData(trailingData);
        await sendAlert(stopLossAlertText(syms));
      }

      return res.json({
        decision, violations, blocked,
        usage: { input_tokens: 0, output_tokens: 0 },
        execution,
        stopLossBypass: true,
      });
    }

    // ── Pre-flight trailing stop check ───────────────────────────────────────
    if (mandate.trailingStopPct) {
      const trailingTriggers = scanTrailingStops(
        livePortfolio.holdings, market, trailingData, mandate.trailingStopPct
      );
      if (trailingTriggers.length > 0) {
        const syms = trailingTriggers.map(t => t.symbol);
        console.warn(`[Mercer] Trailing stop bypass: ${trailingTriggers.map(t => `${t.symbol} -${t.dropFromPeakPct.toFixed(2)}% from peak`).join('; ')}`);

        const trades = trailingTriggers.map(({ symbol, dropFromPeakPct, highWaterMark, holding }) => ({
          type:      'sell',
          asset:     symbol,
          amountUsd: holding.valueUsd,
          reason:    `Trailing stop: ${dropFromPeakPct.toFixed(2)}% below peak $${highWaterMark.toFixed(4)} — protecting gains`,
        }));

        const rawDecision = {
          action:     'sell',
          rationale:  `Trailing stop triggered for ${syms.join(', ')} — mandatory exits to protect unrealized gains.`,
          trades,
          riskFlags:  trailingTriggers.map(t => `TRAILING-STOP: ${t.symbol} -${t.dropFromPeakPct.toFixed(2)}% from peak`),
          confidence: 1.0,
        };

        const { decision, violations, blocked } = enforceMandate(rawDecision, mandate, livePortfolio, market);
        recordDecision(decision, blocked);
        const execution = await executeDecision(decision, market);
        if (execution?.trades?.some(t => t.status === 'executed' || t.status === 'dry_run')) {
          lastExecutionAt = Date.now();
          syms.forEach(s => { trailingData = clearSymbolState(trailingData, s); });
          saveTrailingData(trailingData);
          await sendAlert(`Trailing stop triggered: ${syms.join(', ')} — exits executed to protect gains.`);
        }

        return res.json({
          decision, violations, blocked,
          usage: { input_tokens: 0, output_tokens: 0 },
          execution,
          trailingStopBypass: true,
        });
      }
    }

    // ── Pre-flight profit ladder check ───────────────────────────────────────
    if (mandate.takeProfitLadder?.length) {
      const { trades: ladderTrades, updatedData } = scanProfitLadder(
        livePortfolio.holdings, trailingData, mandate.takeProfitLadder
      );
      if (ladderTrades.length > 0) {
        trailingData = updatedData;
        saveTrailingData(trailingData);
        console.log(`[Mercer] Profit ladder bypass: ${ladderTrades.map(t => `${t.asset} rung ${t.ladderRung + 1}`).join(', ')}`);

        const rawDecision = {
          action:     'sell',
          rationale:  `Profit ladder: taking staged profits for ${[...new Set(ladderTrades.map(t => t.asset))].join(', ')}.`,
          trades:     ladderTrades,
          riskFlags:  ladderTrades.map(t => `LADDER-PROFIT: ${t.asset} rung ${t.ladderRung + 1}`),
          confidence: 1.0,
        };

        const { decision, violations, blocked } = enforceMandate(rawDecision, mandate, livePortfolio, market);
        recordDecision(decision, blocked);
        const execution = await executeDecision(decision, market);
        if (execution?.trades?.some(t => t.status === 'executed' || t.status === 'dry_run')) {
          lastExecutionAt = Date.now();
          const desc = ladderTrades.map(t => `${t.asset} rung ${t.ladderRung + 1}: $${t.amountUsd}`).join('\n');
          await sendAlert(`Profit ladder executed:\n${desc}`);
        }

        return res.json({
          decision, violations, blocked,
          usage: { input_tokens: 0, output_tokens: 0 },
          execution,
          profitLadderBypass: true,
        });
      }
    }

    // ── Pre-flight take-profit check — bypass Claude if targets are hit ─────────
    const triggeredTakeProfits = scanTakeProfits(livePortfolio, mandate);
    if (triggeredTakeProfits.length > 0) {
      console.log(`[Mercer] Take-profit bypass triggered: ${triggeredTakeProfits.join('; ')}`);

      const takeProfitTrades = livePortfolio.holdings
        .filter(h => h.symbol !== 'USDC' && mandate.takeProfitPct && h.pnlPct >= mandate.takeProfitPct)
        .map(h => ({
          type:      'sell',
          asset:     h.symbol,
          amountUsd: h.valueUsd * 0.5, // sell 50% of position
          reason:    `Take-profit: +${h.pnlPct.toFixed(2)}% PnL reached +${mandate.takeProfitPct}% target — selling 50%`,
        }));

      const rawDecision = {
        action:     'sell',
        rationale:  `Take-profit target reached for: ${triggeredTakeProfits.join(', ')}. Selling 50% of each position to lock in gains.`,
        trades:     takeProfitTrades,
        riskFlags:  triggeredTakeProfits.map(s => `TAKE-PROFIT: ${s}`),
        confidence: 1.0,
      };

      const { decision, violations, blocked } = enforceMandate(rawDecision, mandate, livePortfolio, market);
      recordDecision(decision, blocked);

      const execution = await executeDecision(decision, market);
      if (execution?.trades?.some(t => t.status === 'executed' || t.status === 'dry_run')) {
        lastExecutionAt = Date.now();
        await sendAlert(takeProfitAlertText(triggeredTakeProfits.map(s => s.split(':')[0])));
      }

      return res.json({
        decision, violations, blocked,
        usage: { input_tokens: 0, output_tokens: 0 },
        execution,
        takeProfitBypass: true,
      });
    }

    // Save updated HWMs before handing off to Claude
    saveTrailingData(trailingData);

    // Run reasoning loop
    const cycleStart = Date.now();
    const { decision, violations, blocked, usage } = await reason({
      portfolio:      livePortfolio,
      market,
      mandate,
      trigger,
      trailingData,
      stopCooldowns:  getActiveCooldowns(),
    });
    recordCycle(Date.now() - cycleStart);

    // ── Always log the decision outcome ──────────────────────────────────────
    const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    console.log(`[Mercer] ${ts} — Decision: ${decision.action} — confidence: ${decision.confidence ?? 'n/a'}`);

    // ── Auto-execute (or dry-run) ─────────────────────────────────────────────
    let execution = null;

    if (!blocked) {
      const autoExecute      = process.env.AUTO_EXECUTE === 'true';
      const minIntervalSec   = parseInt(process.env.MIN_CYCLE_INTERVAL, 10) || 300;
      const minConfidence    = parseFloat(process.env.MIN_CONFIDENCE) || 0.68;
      const secSinceLast     = lastExecutionAt ? (Date.now() - lastExecutionAt) / 1000 : Infinity;
      const throttled        = autoExecute && secSinceLast < minIntervalSec;
      const lowConfidence    = (decision.confidence ?? 1) < minConfidence;

      if (autoExecute && !throttled && !lowConfidence && decision.action !== 'hold') {
        const tradeDesc = decision.trades?.map(t => `${t.asset} ${t.type} $${t.amountUsd}`).join(', ') || decision.action;
        console.log(`[Mercer] Auto-executing: ${decision.action} — ${tradeDesc}`);
        execution = await executeDecision(decision, market);
        if (execution?.trades?.some(t => t.status === 'executed' || t.status === 'dry_run')) {
          lastExecutionAt = Date.now();
          const alerts = execution.trades
            .filter(t => t.status === 'executed' || t.status === 'dry_run')
            .map(t => tradeAlertText(t, t.status));
          if (alerts.length > 0) await sendAlert(alerts.join('\n'));
        }
        const failed = execution?.trades?.filter(t => t.status === 'failed') ?? [];
        if (failed.length > 0) {
          await sendAlert(`Warning: Trade execution FAILED for ${failed.map(t => t.asset).join(', ')} — check logs and retry manually.`);
        }
      } else if (lowConfidence) {
        console.log(`[Mercer] Skipped — confidence ${((decision.confidence ?? 0) * 100).toFixed(0)}% below minimum ${(minConfidence * 100).toFixed(0)}%`);
        execution = { status: 'skipped_low_confidence', confidence: decision.confidence, minConfidence };
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
