// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — routes/stats.js
// GET /stats — live engine metrics
// State is held in memory for the lifetime of the server process.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { getTradeStats } from '../agent/trade-outcomes.js';

// ─── In-memory state ──────────────────────────────────────────────────────────

const serverStartAt   = new Date().toISOString();
let   cyclesTotal     = 0;
let   lastCycleAt     = null;
let   totalDecisionMs = 0;  // accumulator for rolling average

// ─── Exported hook ────────────────────────────────────────────────────────────

/**
 * Called by the /reason route after each completed reasoning cycle.
 * @param {number} durationMs - Wall-clock time for the full cycle in ms
 */
export function recordCycle(durationMs) {
  cyclesTotal++;
  lastCycleAt     = new Date().toISOString();
  totalDecisionMs += durationMs;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export function getStats() {
  return {
    cyclesTotal,
    lastCycleAt,
    serverStartAt,
    uptimePct:    100,
    avgDecisionMs: cyclesTotal > 0 ? Math.round(totalDecisionMs / cyclesTotal) : null,
  };
}

const router = Router();

router.get('/', (_req, res) => {
  res.json({ ...getStats(), tradeStats: getTradeStats() });
});

export default router;
