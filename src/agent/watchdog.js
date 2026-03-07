// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — agent/watchdog.js
// Fast protection + profit monitor — runs every WATCHDOG_INTERVAL_MS (30s default).
// Independent of the 900s reasoning cycle. Handles:
//   1. Entry-based stop-loss   — exit if down X% from entry price
//   2. Trailing stop-loss      — exit if down X% from the all-time peak price
//   3. Profit ladder           — staged partial sells as PnL hits each rung
//   4. 1-hour momentum alert   — early warning if any holding drops >5% in 1h
// ─────────────────────────────────────────────────────────────────────────────

import { fetchSolanaMarketMap }          from '../market/solana-market.js';
import { fetchWalletPortfolio }          from '../wallet/solana.js';
import { DEFAULT_BASE_PORTFOLIO, buildLivePortfolio } from './portfolio.js';
import { loadEntryPrices, saveEntryPrices, applyEntryPrices } from './entry-prices.js';
import {
  loadTrailingData, saveTrailingData,
  updateHighWaterMarks, scanTrailingStops,
  scanProfitLadder, clearSymbolState,
} from './trailing-stops.js';
import { scanStopLosses, enforceMandate, MANDATE_PRESETS } from './mandate.js';
import { recordDecision }                from './reasoning.js';
import { executeDecision }               from '../executor.js';
import { sendAlert, stopLossAlertText }  from '../notify.js';
import { signalEarlyReason }             from '../trade-signal.js';
import { recordStopOut }                 from './stop-cooldown.js';

const WATCHDOG_INTERVAL_MS  = parseInt(process.env.WATCHDOG_INTERVAL_MS, 10) || 30_000;
const ALERT_1H_DROP_PCT     = parseFloat(process.env.ALERT_1H_DROP_PCT)    || 5.0;
const MOMENTUM_BUY_1H_PCT   = parseFloat(process.env.MOMENTUM_BUY_1H_PCT)  || 7.0;
const MOMENTUM_BUY_CD_MS    = 2 * 60 * 60 * 1000; // 2h between triggers for same symbol

// Per-symbol cooldown — prevents re-firing the same trigger within 15 minutes
const COOLDOWN_MS   = 15 * 60 * 1000;
const MOMENTUM_CD   = 60 * 60 * 1000; // 1 hour between momentum alerts
const lastTriggered = new Map(); // symbol -> { stopLoss, trailingStop, momentum }

function isCoolingDown(symbol, type) {
  const cd  = type === 'momentum' ? MOMENTUM_CD : COOLDOWN_MS;
  const ts  = lastTriggered.get(symbol)?.[type] ?? 0;
  return (Date.now() - ts) < cd;
}

function markTriggered(symbol, type) {
  const entry = lastTriggered.get(symbol) ?? {};
  lastTriggered.set(symbol, { ...entry, [type]: Date.now() });
}

let _timer             = null;
let _consecutiveErrors = 0;
const MAX_ERRORS       = 5; // alert after 5 straight failures (~2.5 min at 30s interval)

export function startWatchdog(mandateKey = process.env.MERCER_MANDATE ?? 'moderate') {
  const mandate = MANDATE_PRESETS[mandateKey] ?? MANDATE_PRESETS.moderate;
  console.log(`[Mercer Watchdog] Started — checking every ${WATCHDOG_INTERVAL_MS / 1000}s (mandate: ${mandate.riskTier})`);

  async function check() {
    try {
      // ── Resolve portfolio ────────────────────────────────────────────────────
      let basePortfolio;
      const { SOLANA_RPC_URL, WALLET_ADDRESS } = process.env;
      if (SOLANA_RPC_URL && WALLET_ADDRESS) {
        try {
          basePortfolio = await fetchWalletPortfolio(WALLET_ADDRESS, SOLANA_RPC_URL);
        } catch {
          basePortfolio = DEFAULT_BASE_PORTFOLIO;
        }
      } else {
        basePortfolio = DEFAULT_BASE_PORTFOLIO;
      }

      // Use the same ecosystem market map Claude uses — covers any token Mercer may hold,
      // not just the hardcoded COINGECKO_IDS list. Served from cache (120s TTL) so no extra CoinGecko calls.
      const market = await fetchSolanaMarketMap(150);
      if (!market || Object.keys(market).length === 0) return;

      const persisted = loadEntryPrices();
      const { holdings: enrichedHoldings, updated } = applyEntryPrices(basePortfolio.holdings, market, persisted);
      saveEntryPrices(updated);
      const livePortfolio = buildLivePortfolio({ ...basePortfolio, holdings: enrichedHoldings }, market);

      // ── Update high-water marks ──────────────────────────────────────────────
      let trailingData = loadTrailingData();
      trailingData = updateHighWaterMarks(livePortfolio.holdings, market, trailingData);

      // ── 1. Entry-based stop-loss ─────────────────────────────────────────────
      const stopLosses = scanStopLosses(livePortfolio, mandate).filter(msg => {
        const sym = msg.split(':')[0].trim();
        return !isCoolingDown(sym, 'stopLoss');
      });

      if (stopLosses.length > 0) {
        const syms = stopLosses.map(s => s.split(':')[0].trim());
        console.warn(`[Mercer Watchdog] Stop-loss triggered: ${stopLosses.join('; ')}`);

        const trades = livePortfolio.holdings
          .filter(h => h.pnlPct <= -mandate.stopLossPct && !isCoolingDown(h.symbol, 'stopLoss'))
          .map(h => ({
            type:      'sell',
            asset:     h.symbol,
            amountUsd: h.valueUsd,
            reason:    `Watchdog stop-loss: ${h.pnlPct.toFixed(2)}% breached -${mandate.stopLossPct}% threshold`,
          }));

        const rawDecision = {
          action:     'sell',
          rationale:  `Watchdog stop-loss: mandatory exit for ${syms.join(', ')}.`,
          trades,
          riskFlags:  stopLosses.map(s => `STOP-LOSS: ${s}`),
          confidence: 1.0,
        };

        const { decision, blocked } = enforceMandate(rawDecision, mandate, livePortfolio);
        recordDecision(decision, blocked);
        const execution = await executeDecision(decision, market);
        syms.forEach(s => {
          markTriggered(s, 'stopLoss');
          trailingData = clearSymbolState(trailingData, s);
          recordStopOut(s); // block re-entry for 4h
        });

        const failed = execution?.trades?.filter(t => t.status === 'failed') ?? [];
        if (failed.length > 0) {
          await sendAlert(`Warning: Stop-loss execution FAILED for ${failed.map(t => t.asset).join(', ')} — manual exit required immediately.`);
        } else if (execution?.trades?.some(t => t.status === 'executed' || t.status === 'dry_run')) {
          await sendAlert(stopLossAlertText(syms));
        }
      }

      // ── 2. Trailing stop-loss ────────────────────────────────────────────────
      if (mandate.trailingStopPct) {
        const trailingTriggers = scanTrailingStops(
          livePortfolio.holdings, market, trailingData, mandate.trailingStopPct
        ).filter(t => !isCoolingDown(t.symbol, 'trailingStop'));

        if (trailingTriggers.length > 0) {
          const syms = trailingTriggers.map(t => t.symbol);
          console.warn(`[Mercer Watchdog] Trailing stop triggered: ${trailingTriggers.map(t =>
            `${t.symbol} down ${t.dropFromPeakPct.toFixed(2)}% from peak $${t.highWaterMark}`
          ).join('; ')}`);

          const trades = trailingTriggers
            .filter(t => !isCoolingDown(t.symbol, 'trailingStop'))
            .map(({ symbol, dropFromPeakPct, highWaterMark, holding }) => ({
              type:      'sell',
              asset:     symbol,
              amountUsd: holding.valueUsd,
              reason:    `Trailing stop: ${dropFromPeakPct.toFixed(2)}% below peak $${highWaterMark.toFixed(4)} — protecting gains`,
            }));

          const rawDecision = {
            action:     'sell',
            rationale:  `Watchdog trailing stop: protecting gains for ${syms.join(', ')}.`,
            trades,
            riskFlags:  trailingTriggers.map(t => `TRAILING-STOP: ${t.symbol} -${t.dropFromPeakPct.toFixed(2)}% from peak`),
            confidence: 1.0,
          };

          const { decision, blocked } = enforceMandate(rawDecision, mandate, livePortfolio);
          recordDecision(decision, blocked);
          const execution = await executeDecision(decision, market);
          syms.forEach(s => {
            markTriggered(s, 'trailingStop');
            trailingData = clearSymbolState(trailingData, s);
            recordStopOut(s); // block re-entry for 4h
          });

          const failed = execution?.trades?.filter(t => t.status === 'failed') ?? [];
          if (failed.length > 0) {
            await sendAlert(`Warning: Trailing stop execution FAILED for ${failed.map(t => t.asset).join(', ')} — manual exit required.`);
          } else if (execution?.trades?.some(t => t.status === 'executed' || t.status === 'dry_run')) {
            await sendAlert(`Trailing stop triggered: ${syms.join(', ')} — exited to protect gains.`);
          }
        }
      }

      // ── 3. Profit ladder ─────────────────────────────────────────────────────
      if (mandate.takeProfitLadder?.length) {
        const { trades: ladderTrades, updatedData } = scanProfitLadder(
          livePortfolio.holdings, trailingData, mandate.takeProfitLadder
        );

        if (ladderTrades.length > 0) {
          trailingData = updatedData;
          console.log(`[Mercer Watchdog] Profit ladder: ${ladderTrades.map(t =>
            `${t.asset} rung ${t.ladderRung + 1} $${t.amountUsd}`
          ).join(', ')}`);

          const rawDecision = {
            action:     'sell',
            rationale:  `Watchdog profit ladder: taking staged profits across ${[...new Set(ladderTrades.map(t => t.asset))].join(', ')}.`,
            trades:     ladderTrades,
            riskFlags:  ladderTrades.map(t => `LADDER-PROFIT: ${t.asset} rung ${t.ladderRung + 1}`),
            confidence: 1.0,
          };

          const { decision, blocked } = enforceMandate(rawDecision, mandate, livePortfolio);
          recordDecision(decision, blocked);
          const execution = await executeDecision(decision, market);

          if (execution?.trades?.some(t => t.status === 'executed' || t.status === 'dry_run')) {
            const desc = ladderTrades.map(t =>
              `${t.asset} rung ${t.ladderRung + 1}: $${t.amountUsd} (${t.reason.match(/selling (\d+%)/)?.[1] ?? ''})`
            ).join('\n');
            await sendAlert(`Profit ladder executed:\n${desc}`);
          }
        }
      }

      // ── 4. Momentum buy trigger — breakout in an unowned token ───────────────
      // Scans all 150 ecosystem tokens for strong 1h moves Mercer doesn't hold.
      // Fires an early reasoning cycle so Claude can evaluate the breakout immediately
      // rather than waiting up to 10 minutes for the next scheduled cycle.
      const heldSymbols = new Set(livePortfolio.holdings.map(h => h.symbol));
      for (const [symbol, data] of Object.entries(market)) {
        if (heldSymbols.has(symbol) || symbol === 'USDC') continue;
        if ((data.change1h ?? 0) < MOMENTUM_BUY_1H_PCT) continue;
        // Volume and market cap gates
        if (mandate.minVolume24hUsd  && (data.volume24hUsd  ?? 0) < mandate.minVolume24hUsd)  continue;
        if (mandate.minMarketCapUsd  && (data.marketCapUsd  ?? 0) < mandate.minMarketCapUsd)  continue;

        // Per-symbol 2h cooldown to avoid hammering Claude on the same breakout
        const cdKey = `${symbol}:momentumBuy`;
        const lastMs = lastTriggered.get(cdKey) ?? 0;
        if ((Date.now() - lastMs) < MOMENTUM_BUY_CD_MS) continue;

        lastTriggered.set(cdKey, Date.now());
        console.log(`[Mercer Watchdog] Momentum breakout: ${symbol} +${data.change1h.toFixed(2)}% in 1h — firing early reasoning cycle`);
        await sendAlert(`Momentum breakout: ${symbol} +${data.change1h.toFixed(2)}% in 1h (vol: $${((data.volume24hUsd ?? 0) / 1e6).toFixed(1)}M) — triggering early review`);
        signalEarlyReason();
        break; // one trigger per watchdog tick is enough
      }

      // ── 5. 1-hour momentum alert ─────────────────────────────────────────────
      for (const h of livePortfolio.holdings) {
        if (h.symbol === 'USDC') continue;
        const change1h = market[h.symbol]?.change1h;
        if (change1h == null) continue;
        if (change1h <= -ALERT_1H_DROP_PCT && !isCoolingDown(h.symbol, 'momentum')) {
          markTriggered(h.symbol, 'momentum');
          await sendAlert(
            `Momentum alert: ${h.symbol} down ${Math.abs(change1h).toFixed(2)}% in 1h — stop-loss at -${mandate.stopLossPct}%, trailing stop at -${mandate.trailingStopPct ?? 'n/a'}% from peak`
          );
        }
      }

      // ── Save updated trailing data ────────────────────────────────────────────
      saveTrailingData(trailingData);
      _consecutiveErrors = 0; // healthy cycle — reset counter

    } catch (err) {
      _consecutiveErrors++;
      console.warn(`[Mercer Watchdog] Check error (${_consecutiveErrors}/${MAX_ERRORS}): ${err.message}`);
      if (_consecutiveErrors >= MAX_ERRORS) {
        _consecutiveErrors = 0; // reset to avoid spam on next batch
        await sendAlert(`Warning: Watchdog has failed ${MAX_ERRORS} consecutive checks — stop-loss protection may be down. Last error: ${err.message}`);
      }
    }
  }

  _timer = setInterval(check, WATCHDOG_INTERVAL_MS);
  return _timer;
}

export function stopWatchdog() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
