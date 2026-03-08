// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — routes/reason.js
// POST /reason — run a full reasoning cycle with live market data
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { reason, recordDecision, getRecentDecisions } from '../agent/reasoning.js';
import { MANDATE_PRESETS, enforceMandate, scanStopLosses, scanTakeProfits } from '../agent/mandate.js';
import { loadTrailingData, saveTrailingData, updateHighWaterMarks, scanTrailingStops, scanProfitLadder, clearSymbolState } from '../agent/trailing-stops.js';
import { fetchSolanaMarketMap } from '../market/solana-market.js';
import { fetchNewLaunches } from '../market/dexscreener.js';
import { DEFAULT_BASE_PORTFOLIO, buildLivePortfolio } from '../agent/portfolio.js';
import { fetchWalletPortfolio } from '../wallet/solana.js';
import { loadEntryPrices, saveEntryPrices, applyEntryPrices, loadPeakValue, savePeakValue } from '../agent/entry-prices.js';
import { recordCycle } from './stats.js';
import { executeDecision } from '../executor.js';
import { recordSnapshot } from '../history.js';
import { sendAlert, stopLossAlertText, takeProfitAlertText, tradeAlertText } from '../notify.js';
import { getActiveCooldowns } from '../agent/stop-cooldown.js';
import { getBlockedBuys } from '../agent/blocked-buys.js';
import { getSpikeRatio } from '../market/volume-tracker.js';
import { recordTradeOutcome } from '../agent/trade-outcomes.js';

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

    // Fetch up to 400 Solana ecosystem tokens (2 pages × 250) — full universe for Claude.
    // Page 2 is cached independently; first cycle may have ~250, subsequent cycles up to ~400.
    let market;
    try {
      market = await fetchSolanaMarketMap(400);
      // Augment each token with its volume spike ratio (current vs rolling baseline)
      for (const [symbol, data] of Object.entries(market)) {
        if (data.volume24hUsd) {
          data.spikeRatio = getSpikeRatio(symbol, data.volume24hUsd);
        }
      }
      // Merge DexScreener new launches — fills in sub-$1M tokens CoinGecko misses
      try {
        const newLaunches = await fetchNewLaunches();
        for (const [symbol, data] of Object.entries(newLaunches)) {
          if (!market[symbol]) market[symbol] = data; // don't override CoinGecko data
        }
        if (Object.keys(newLaunches).length > 0) {
          console.log(`[Mercer] DexScreener: ${Object.keys(newLaunches).length} new launches merged into market`);
        }
      } catch (err) {
        console.warn(`[Mercer] DexScreener merge failed: ${err.message}`);
      }
    } catch (err) {
      return next(Object.assign(new Error(err.message), { status: 400 }));
    }

    // Apply persisted entry prices — prevents PnL resetting to 0% on every cycle
    if (!portfolioInput) {
      const persisted = loadEntryPrices();
      const { holdings: enrichedHoldings, updated } = applyEntryPrices(basePortfolio.holdings, market, persisted);
      basePortfolio = { ...basePortfolio, holdings: enrichedHoldings };
      saveEntryPrices(updated);

      // Load persisted peak — applied after buildLivePortfolio so we have priced holdings
      const storedPeak = loadPeakValue();
      if (storedPeak > 0) {
        basePortfolio = { ...basePortfolio, peakValueUsd: storedPeak };
      }
    }

    // Build enriched portfolio (holdings get USD values from market prices here)
    const livePortfolio = buildLivePortfolio(basePortfolio, market);

    // Stale peak check — must run AFTER buildLivePortfolio so totalValueUsd is priced correctly.
    // If stored peak is >2× the live portfolio value it is almost certainly a stale value from a
    // mock-portfolio run or a previous wallet — reset to current to prevent permanent halt.
    if (!portfolioInput) {
      const storedPeak   = livePortfolio.peakValueUsd;
      const currentTotal = livePortfolio.totalValueUsd;
      const peakIsStale  = storedPeak > 0 && currentTotal > 0 && storedPeak > currentTotal * 2;
      if (peakIsStale) {
        console.warn(`[Mercer] Stale peak detected ($${storedPeak.toFixed(2)} vs live $${currentTotal.toFixed(2)}) — resetting to current value.`);
        savePeakValue(currentTotal);
        livePortfolio.peakValueUsd = currentTotal;
      }
    }

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
    const triggeredStopLosses = scanStopLosses(livePortfolio, mandate, market);
    if (triggeredStopLosses.length > 0) {
      console.warn(`[Mercer] Stop-loss bypass triggered: ${triggeredStopLosses.join('; ')}`);

      const stopLossTrades = livePortfolio.holdings
        .filter(h => {
          const cap        = market[h.symbol]?.marketCapUsd ?? Infinity;
          const isMicroCap = mandate.microCapThresholdUsd && cap < mandate.microCapThresholdUsd;
          const stopPct    = isMicroCap && mandate.microCapStopLossPct ? mandate.microCapStopLossPct : mandate.stopLossPct;
          return h.pnlPct <= -stopPct;
        })
        .map(h => ({
          type:      'sell',
          asset:     h.symbol,
          amountUsd: h.valueUsd,
          reason:    `Mandatory stop-loss exit: ${h.pnlPct.toFixed(2)}% PnL breached threshold`,
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

    // Extract recent trades from decision history so Claude avoids repeating itself
    const recentTrades = getRecentDecisions(10)
      .flatMap(d => (d.trades ?? []).map(t => ({
        time:      d.timestamp,
        type:      t.type,
        asset:     t.asset ?? null,
        fromAsset: t.fromAsset ?? null,
        toAsset:   t.toAsset ?? null,
        amountUsd: t.amountUsd,
      })))
      .slice(-12); // last 12 trades across the last 10 decisions

    // Run reasoning loop
    const cycleStart = Date.now();
    const { decision, violations, blocked, usage } = await reason({
      portfolio:      livePortfolio,
      market,
      mandate,
      trigger,
      trailingData,
      stopCooldowns:  getActiveCooldowns(),
      blockedBuys:    getBlockedBuys(),
      recentTrades,
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
      const SKIP_BELOW       = 0.50; // below this confidence, reasoning.js already strips buys — no need to execute
      const secSinceLast     = lastExecutionAt ? (Date.now() - lastExecutionAt) / 1000 : Infinity;
      const confidence       = decision.confidence ?? 1;
      const bypassThrottle   = confidence >= 0.75 && decision.action !== 'hold';
      const throttled        = autoExecute && secSinceLast < minIntervalSec && !bypassThrottle;
      const lowConfidence    = confidence < SKIP_BELOW;

      if (autoExecute && !throttled && !lowConfidence && decision.action !== 'hold') {
        const tradeDesc = decision.trades?.map(t => t.type === 'swap' ? `${t.fromAsset}→${t.toAsset} $${t.amountUsd}` : `${t.asset} ${t.type} $${t.amountUsd}`).join(', ') || decision.action;
        const bypassNote = bypassThrottle && secSinceLast < minIntervalSec ? ` [throttle bypassed — confidence ${(confidence * 100).toFixed(0)}%]` : '';
        console.log(`[Mercer] Auto-executing: ${decision.action} — ${tradeDesc}${bypassNote}`);
        execution = await executeDecision(decision, market);
        if (execution?.trades?.some(t => t.status === 'executed' || t.status === 'dry_run')) {
          lastExecutionAt = Date.now();
          const currentEntryPricesForAlert = loadEntryPrices();
          const portfolioTotal = livePortfolio?.totalValueUsd ?? null;
          const alerts = execution.trades
            .filter(t => t.status === 'executed' || t.status === 'dry_run')
            .map(t => tradeAlertText(t, t.status, { entryPrice: currentEntryPricesForAlert[t.asset], portfolioTotal }));
          if (alerts.length > 0) await sendAlert(alerts.join('\n'));
        }
        // Record outcomes for win/loss tracking
        const currentEntryPrices = loadEntryPrices();
        for (const t of execution?.trades ?? []) {
          recordTradeOutcome(t, currentEntryPrices, market);
        }
        const failed = execution?.trades?.filter(t => t.status === 'failed') ?? [];
        if (failed.length > 0) {
          await sendAlert(`Warning: Trade execution FAILED for ${failed.map(t => t.asset).join(', ')} — check logs and retry manually.`);
        }
      } else if (lowConfidence) {
        console.log(`[Mercer] Skipped — confidence ${((decision.confidence ?? 0) * 100).toFixed(0)}% below ${(SKIP_BELOW * 100).toFixed(0)}% minimum (buys already stripped by tiered sizing)`);
        execution = { status: 'skipped_low_confidence', confidence: decision.confidence, skipBelow: SKIP_BELOW };
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
