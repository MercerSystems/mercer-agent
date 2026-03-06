// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — agent/stop-cooldown.js
// Tracks recently stopped-out symbols to prevent immediate re-entry after
// a stop-loss or trailing stop fires — avoids buying back into a falling knife.
// Cooldown persists across restarts (data/stop-cooldown.json).
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const FILE        = join(process.cwd(), 'data', 'stop-cooldown.json');
const COOLDOWN_MS = parseInt(process.env.STOP_REENTRY_COOLDOWN_MS) || 4 * 60 * 60 * 1000; // 4h

let _data = null; // lazy-loaded in-memory cache

function load() {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function getData() {
  if (!_data) _data = load();
  return _data;
}

function persist() {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(FILE, JSON.stringify(_data, null, 2));
  } catch (err) {
    console.warn('[Mercer] Could not save stop cooldown:', err.message);
  }
}

/** Record a symbol as just stopped out — blocks re-entry for COOLDOWN_MS. */
export function recordStopOut(symbol) {
  const data = getData();
  data[symbol] = Date.now();
  persist();
  console.log(`[Mercer StopCooldown] ${symbol} blocked from re-entry for ${COOLDOWN_MS / 3_600_000}h`);
}

/** Returns true if the symbol was stopped out within the last COOLDOWN_MS. */
export function isInStopCooldown(symbol) {
  const data = getData();
  const ts   = data[symbol];
  if (!ts) return false;
  return (Date.now() - ts) < COOLDOWN_MS;
}

/**
 * Returns all symbols currently in cooldown with minutes remaining.
 * Injected into Claude's context so it doesn't waste a cycle proposing blocked buys.
 */
export function getActiveCooldowns() {
  const data = getData();
  const now  = Date.now();
  return Object.entries(data)
    .filter(([, ts]) => (now - ts) < COOLDOWN_MS)
    .map(([symbol, ts]) => ({
      symbol,
      minsRemaining: Math.round((ts + COOLDOWN_MS - now) / 60_000),
    }));
}
