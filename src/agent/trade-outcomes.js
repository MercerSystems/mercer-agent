// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — agent/trade-outcomes.js
// Tracks executed trade outcomes: win/loss, P&L per trade, aggregate stats.
// Persists to data/trade-outcomes.json
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const FILE        = join(process.cwd(), 'data', 'trade-outcomes.json');
const MAX_RECORDS = 500;

let _records = null;

function load() {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

function getRecords() {
  if (!_records) _records = load();
  return _records;
}

function persist() {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(FILE, JSON.stringify(_records, null, 2));
  } catch (err) {
    console.warn('[Mercer] Could not save trade outcomes:', err.message);
  }
}

/**
 * Record an executed trade.
 * For sells, computes P&L against the known entry price.
 *
 * @param {object} tradeResult  - Executor result (must have status === 'executed')
 * @param {object} entryPrices  - Map of symbol → entry price (from entry-prices.js)
 * @param {object} market       - Current market snapshot
 */
export function recordTradeOutcome(tradeResult, entryPrices, market) {
  if (tradeResult.status !== 'executed') return;

  const records = getRecords();

  const isSell = tradeResult.type === 'sell';
  const isBuy  = tradeResult.type === 'buy';
  const symbol = tradeResult.asset ?? tradeResult.fromAsset ?? tradeResult.toAsset;
  const price  = market[symbol]?.price ?? null;
  const entry  = entryPrices[symbol]   ?? null;

  let pnlPct  = null;
  let outcome = null;

  if (isSell && entry && price) {
    pnlPct  = parseFloat((((price - entry) / entry) * 100).toFixed(2));
    outcome = pnlPct >= 0 ? 'win' : 'loss';
  }

  records.push({
    timestamp:  new Date().toISOString(),
    type:       tradeResult.type,
    symbol,
    amountUsd:  tradeResult.amountUsd ?? null,
    entryPrice: isBuy ? price : entry,
    exitPrice:  isSell ? price : null,
    pnlPct,
    outcome,
    txid:       tradeResult.txid ?? null,
  });

  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  persist();
}

/**
 * Aggregate performance stats across all recorded closed trades (sells).
 * @returns {{ total, wins, losses, winRate, avgGain, avgLoss }}
 */
export function getTradeStats() {
  const records = getRecords();
  const closed  = records.filter(r => r.outcome !== null);
  const wins    = closed.filter(r => r.outcome === 'win');
  const losses  = closed.filter(r => r.outcome === 'loss');

  return {
    total:   closed.length,
    wins:    wins.length,
    losses:  losses.length,
    winRate: closed.length > 0 ? parseFloat(((wins.length / closed.length) * 100).toFixed(1)) : null,
    avgGain: wins.length   > 0 ? parseFloat((wins.reduce((s, r) => s + r.pnlPct, 0) / wins.length).toFixed(1)) : null,
    avgLoss: losses.length > 0 ? parseFloat((losses.reduce((s, r) => s + r.pnlPct, 0) / losses.length).toFixed(1)) : null,
  };
}

/** Returns the last N trade records (buys + sells). */
export function getRecentTradeOutcomes(n = 20) {
  return getRecords().slice(-n);
}
