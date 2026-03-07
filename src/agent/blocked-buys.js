// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — agent/blocked-buys.js
// Permanent per-symbol buy block. Symbols here will never be bought or swapped
// into, regardless of mandate or market conditions.
// Edit data/blocked-buys.json to add/remove symbols at runtime (restart required).
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const FILE = join(process.cwd(), 'data', 'blocked-buys.json');

let _set = null;

function load() {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    const symbols = JSON.parse(readFileSync(FILE, 'utf8'));
    return new Set(symbols.map(s => s.toUpperCase()));
  } catch {
    return new Set();
  }
}

function getSet() {
  if (!_set) _set = load();
  return _set;
}

/** Returns true if the symbol is permanently blocked from being bought. */
export function isBuyBlocked(symbol) {
  return getSet().has(symbol?.toUpperCase());
}

/** Returns the list of blocked symbols for context injection. */
export function getBlockedBuys() {
  return [...getSet()];
}

/**
 * Permanently blocks a symbol from being bought. Persists to disk immediately.
 * Used to auto-block TOKEN_NOT_TRADABLE failures so Claude stops proposing them.
 */
export function addToBlockedBuys(symbol) {
  const sym = symbol?.toUpperCase();
  if (!sym) return;
  const set = getSet();
  if (set.has(sym)) return; // already blocked
  set.add(sym);
  _set = set;
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(FILE, JSON.stringify([...set], null, 2));
    console.log(`[Mercer] Auto-blocked ${sym} — TOKEN_NOT_TRADABLE (added to data/blocked-buys.json)`);
  } catch (err) {
    console.warn(`[Mercer] Failed to persist blocked-buy for ${sym}: ${err.message}`);
  }
}
