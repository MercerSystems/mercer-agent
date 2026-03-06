// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — agent/trailing-stops.js
//
// Manages two pieces of persistent state in data/trailing-stops.json:
//
//  highWaterMarks   — peak price seen per symbol since tracking began.
//                     Trailing stop fires when current price drops trailingStopPct%
//                     below this mark — not from entry price.
//                     Example: SOL entry $80, ran to $200 (HWM), trailing 15%.
//                     Stop fires at $170, protecting $90 of gain vs $12 entry-based.
//
//  ladderTriggered  — which profit-ladder rung indices have already been executed
//                     per symbol. Prevents re-selling at the same level.
//                     Cleared when a position is fully exited via stop-loss.
//
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const FILE = join(process.cwd(), 'data', 'trailing-stops.json');

function ensureDir() {
  mkdirSync(join(process.cwd(), 'data'), { recursive: true });
}

// ─── Persistence ──────────────────────────────────────────────────────────────

export function loadTrailingData() {
  try {
    ensureDir();
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return { highWaterMarks: {}, ladderTriggered: {} };
  }
}

export function saveTrailingData(data) {
  try {
    ensureDir();
    writeFileSync(FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn('[Mercer] Could not save trailing stop data:', err.message);
  }
}

// ─── High-water mark updates ──────────────────────────────────────────────────

/**
 * Updates high-water marks for all holdings with current prices.
 * Call on every watchdog tick. Returns a new data object — does not mutate.
 */
export function updateHighWaterMarks(holdings, market, data) {
  const hwm = { ...data.highWaterMarks };
  for (const h of holdings) {
    if (h.symbol === 'USDC') continue;
    const price = market[h.symbol]?.price;
    if (!price) continue;
    if (!hwm[h.symbol] || price > hwm[h.symbol]) {
      hwm[h.symbol] = price;
    }
  }
  return { ...data, highWaterMarks: hwm };
}

// ─── Trailing stop scan ───────────────────────────────────────────────────────

/**
 * Returns holdings where the trailing stop has been triggered.
 * Trailing stop fires when: currentPrice < highWaterMark * (1 - trailingStopPct/100)
 *
 * This protects unrealized gains — the stop level rises as the asset appreciates.
 * An asset up 150% from entry will still be protected even if still above entry price.
 *
 * @param {object[]} holdings
 * @param {object}   market
 * @param {object}   data          - Trailing data with highWaterMarks
 * @param {number}   trailingStopPct
 * @returns {{ symbol, currentPrice, highWaterMark, dropFromPeakPct, holding }[]}
 */
export function scanTrailingStops(holdings, market, data, trailingStopPct) {
  if (!trailingStopPct) return [];
  const triggered = [];

  for (const h of holdings) {
    if (h.symbol === 'USDC') continue;
    const currentPrice = market[h.symbol]?.price;
    const hwm          = data.highWaterMarks[h.symbol];
    if (!currentPrice || !hwm) continue;

    const dropFromPeakPct = ((hwm - currentPrice) / hwm) * 100;
    if (dropFromPeakPct >= trailingStopPct) {
      triggered.push({ symbol: h.symbol, currentPrice, highWaterMark: hwm, dropFromPeakPct, holding: h });
    }
  }

  return triggered;
}

// ─── Profit ladder scan ───────────────────────────────────────────────────────

/**
 * Checks all holdings against a tiered take-profit ladder.
 * Each rung fires once per symbol — triggered rung indices are persisted so they
 * survive across restarts.
 *
 * Ladder format (from mandate):
 *   [{ pct: 30, sellFraction: 0.25 }, { pct: 55, sellFraction: 0.25 }, ...]
 *   pct          — PnL% from entry that triggers this rung
 *   sellFraction — fraction of the CURRENT position value to sell at this rung
 *
 * @param {object[]} holdings   - Live portfolio holdings with pnlPct + valueUsd
 * @param {object}   data       - Trailing data with ladderTriggered state
 * @param {object[]} ladder     - Mandate's takeProfitLadder array
 * @returns {{ trades: object[], updatedData: object }}
 */
export function scanProfitLadder(holdings, data, ladder) {
  if (!ladder?.length) return { trades: [], updatedData: data };

  const trades       = [];
  const newTriggered = { ...data.ladderTriggered };

  for (const h of holdings) {
    if (h.symbol === 'USDC') continue;

    const alreadyHit = new Set(newTriggered[h.symbol] ?? []);

    for (let i = 0; i < ladder.length; i++) {
      if (alreadyHit.has(i)) continue; // rung already executed

      const rung = ladder[i];
      if (h.pnlPct >= rung.pct) {
        const amountUsd = h.valueUsd * rung.sellFraction;
        trades.push({
          type:      'sell',
          asset:     h.symbol,
          amountUsd: parseFloat(amountUsd.toFixed(2)),
          reason:    `Ladder rung ${i + 1}: +${h.pnlPct.toFixed(2)}% reached +${rung.pct}% target — selling ${(rung.sellFraction * 100).toFixed(0)}% of position`,
          ladderRung: i,
        });
        alreadyHit.add(i);
      }
    }

    if (alreadyHit.size > 0) {
      newTriggered[h.symbol] = [...alreadyHit];
    }
  }

  return { trades, updatedData: { ...data, ladderTriggered: newTriggered } };
}

/**
 * Clears ladder state for a symbol after a full exit (stop-loss / manual sell).
 * Call this whenever a position is fully sold so the ladder resets if re-entered.
 */
export function clearSymbolState(data, symbol) {
  const hwm     = { ...data.highWaterMarks };
  const ladder  = { ...data.ladderTriggered };
  delete hwm[symbol];
  delete ladder[symbol];
  return { ...data, highWaterMarks: hwm, ladderTriggered: ladder };
}
