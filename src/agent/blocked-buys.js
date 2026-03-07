// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — agent/blocked-buys.js
// Permanent per-symbol buy block. Symbols here will never be bought or swapped
// into, regardless of mandate or market conditions.
// Edit data/blocked-buys.json to add/remove symbols at runtime (restart required).
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, mkdirSync } from 'fs';
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
