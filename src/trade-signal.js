// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — trade-signal.js
// Lightweight in-process signal: tracks when the last trade was confirmed.
// The /events endpoint exposes this so the dashboard can poll and react
// immediately instead of waiting for the next DATA_REFRESH_MS tick.
// ─────────────────────────────────────────────────────────────────────────────

let _lastTradeAt  = null;
let _earlyReason  = false;

/** Call this after any trade is confirmed on-chain. */
export function signalTrade() {
  _lastTradeAt = new Date().toISOString();
}

/** Returns ISO timestamp of the most recent confirmed trade, or null. */
export function getLastTradeAt() {
  return _lastTradeAt;
}

/** Signal the dashboard to trigger an early full reasoning cycle (e.g. momentum breakout). */
export function signalEarlyReason() {
  _earlyReason = true;
}

/** Consume the early-reason flag — returns true once then resets to false. */
export function consumeEarlyReason() {
  const val    = _earlyReason;
  _earlyReason = false;
  return val;
}
