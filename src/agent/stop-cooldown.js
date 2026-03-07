// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — agent/stop-cooldown.js
// Tracks recently stopped-out symbols to prevent immediate re-entry after
// a stop-loss or trailing stop fires — avoids buying back into a falling knife.
// Cooldown persists across restarts (data/stop-cooldown.json).
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const FILE        = join(process.cwd(), 'data', 'stop-cooldown.json');
const COOLDOWN_MS = parseInt(process.env.STOP_REENTRY_COOLDOWN_MS) || 24 * 60 * 60 * 1000; // 24h

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

/**
 * Returns true if the symbol is still in stop-loss cooldown.
 * Once the time window expires, also checks momentum — if both 1h and 24h are
 * still negative, holds the block until momentum turns positive (prevents
 * re-entering a token that is still in a downtrend after the base cooldown).
 *
 * @param {string} symbol
 * @param {object} [market] - Optional market snapshot for momentum gate
 */
export function isInStopCooldown(symbol, market = null) {
  const data      = getData();
  const stoppedAt = data[symbol];
  if (!stoppedAt) return false;

  const elapsed = Date.now() - stoppedAt;

  // Still within the base cooldown window — always blocked
  if (elapsed < COOLDOWN_MS) return true;

  // Base cooldown expired — apply momentum gate if market data available
  if (market) {
    const mkt  = market[symbol];
    const ch1h  = mkt?.change1h  ?? null;
    const ch24h = mkt?.change24h ?? null;
    // Both timeframes still negative → token still declining, extend block
    if (ch1h !== null && ch1h < 0 && ch24h !== null && ch24h < 0) {
      return true;
    }
  }

  // Cooldown fully expired and momentum has turned — clean up
  delete data[symbol];
  persist();
  return false;
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
