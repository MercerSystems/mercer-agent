// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — agent/entry-prices.js
// Persists entry prices to disk so PnL tracking survives across reasoning cycles.
// Without this, entry prices are re-seeded from current market on every restart,
// making stop-loss calculations always read 0% PnL.
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const ENTRY_FILE = join(process.cwd(), 'data', 'entry-prices.json');
const PEAK_FILE  = join(process.cwd(), 'data', 'peak-value.json');

// ─── Peak value persistence ────────────────────────────────────────────────────
// peakValueUsd is used to calculate portfolio drawdown for the maxDrawdownPct
// mandate check. Without persistence it resets to current value on every restart,
// making drawdown protection ineffective after a crash + restart.

export function loadPeakValue() {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    return JSON.parse(readFileSync(PEAK_FILE, 'utf8')).peak ?? 0;
  } catch {
    return 0;
  }
}

export function savePeakValue(peak) {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(PEAK_FILE, JSON.stringify({ peak, updatedAt: new Date().toISOString() }, null, 2));
  } catch (err) {
    console.warn('[Mercer] Could not save peak value:', err.message);
  }
}

export function loadEntryPrices() {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    return JSON.parse(readFileSync(ENTRY_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function saveEntryPrices(prices) {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(ENTRY_FILE, JSON.stringify(prices, null, 2));
  } catch (err) {
    console.warn('[Mercer] Could not save entry prices:', err.message);
  }
}

/**
 * Merges persisted entry prices into holdings.
 * Priority: existing holding.entryPrice > persisted file > current market price (last resort).
 * Only falls back to market price if truly no entry is known — and flags it.
 *
 * @param {object[]} holdings  - Raw holdings with optional entryPrice
 * @param {object}   market    - Current market snapshot
 * @param {object}   persisted - Entry prices loaded from disk
 * @returns {{ holdings: object[], updated: object }} Updated holdings + new persisted map
 */
export function applyEntryPrices(holdings, market, persisted) {
  const updated = { ...persisted };

  const result = holdings.map(h => {
    if (!h.symbol) return { ...h, entryPrice: 0 }; // skip unresolved tokens
    const existing = h.entryPrice > 0 ? h.entryPrice : null;
    const stored   = persisted[h.symbol] > 0 ? persisted[h.symbol] : null; // ignore saved 0s
    const fallback = market[h.symbol]?.price > 0 ? market[h.symbol].price : null;

    const entryPrice = existing ?? stored ?? fallback ?? 0;

    // Only persist if we have a real price, and only once per symbol
    if (updated[h.symbol] == null) {
      if (entryPrice > 0) {
        updated[h.symbol] = entryPrice;
        if (!existing && !stored) {
          console.log(`[Mercer] Entry price for ${h.symbol} seeded from market ($${entryPrice.toFixed(6)})`);
        }
      }
      // If price is still 0, silently wait — will seed on next cycle when price is available
    }

    return { ...h, entryPrice };
  });

  return { holdings: result, updated };
}
