// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — mandate.js
// Risk rule enforcement engine
// Validates Claude's proposed decisions against the active risk mandate
// before any trade reaches the execution layer.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Built-in mandate presets.
 * Users can extend or override these via their personal mandate config.
 */
export const MANDATE_PRESETS = {
  conservative: {
    riskTier: 'conservative',
    maxPositionPct:   20,
    stopLossPct:      10,
    trailingStopPct:  8,
    takeProfitPct:    20,
    takeProfitLadder: [
      { pct: 15, sellFraction: 0.33 },
      { pct: 25, sellFraction: 0.33 },
      { pct: 40, sellFraction: 0.34 },
    ],
    maxDrawdownPct:   15,
    minCashPct:       25,          // Always keep ≥25% of portfolio as USDC dry powder
    minMarketCapUsd:  500_000_000, // Only trade tokens with >$500M market cap
    minVolume24hUsd:  10_000_000,  // Only trade tokens with >$10M daily volume
    notes: 'Capital preservation. Large-cap Solana tokens only — no meme coins.',
  },
  moderate: {
    riskTier: 'moderate',
    maxPositionPct:   35,
    stopLossPct:      20,
    trailingStopPct:  15,
    takeProfitPct:    40,
    takeProfitLadder: [
      { pct: 30, sellFraction: 0.25 },
      { pct: 55, sellFraction: 0.25 },
      { pct: 90, sellFraction: 0.50 },
    ],
    maxDrawdownPct:   25,
    minCashPct:       15,         // Always keep ≥15% of portfolio as USDC dry powder
    minMarketCapUsd:  50_000_000, // Only trade tokens with >$50M market cap
    minVolume24hUsd:  5_000_000,  // Only trade tokens with >$5M daily volume
    notes: 'Balanced growth. Pick the best opportunities across the Solana ecosystem — evaluate all tokens equally by momentum and market conditions.',
  },
  aggressive: {
    riskTier: 'aggressive',
    maxPositionPct:   50,
    stopLossPct:      35,
    trailingStopPct:  25,
    takeProfitPct:    60,
    takeProfitLadder: [
      { pct: 40,  sellFraction: 0.25 },
      { pct: 75,  sellFraction: 0.25 },
      { pct: 120, sellFraction: 0.50 },
    ],
    maxDrawdownPct:   40,
    minCashPct:       10,        // Always keep ≥10% of portfolio as USDC dry powder
    minMarketCapUsd:  5_000_000, // Only trade tokens with >$5M market cap
    minVolume24hUsd:  1_000_000, // Only trade tokens with >$1M daily volume
    notes: 'High risk/reward. Any liquid Solana token with momentum — pick winners, not favorites.',
  },
};

import { isInStopCooldown } from './stop-cooldown.js';

/**
 * Checks a Claude-generated decision against the active mandate.
 * Returns a validated (and potentially pruned) decision with any violations flagged.
 *
 * @param {object} decision  - Raw decision object from Claude
 * @param {object} mandate   - Active risk mandate
 * @param {object} portfolio - Current portfolio state
 * @returns {{ decision: object, violations: string[], blocked: boolean }}
 */
export function enforceMandate(decision, mandate, portfolio, market = {}) {
  const violations = [];
  let blocked = false;

  // ── 1. Mandate-level halt: portfolio drawdown exceeded ──────────────────────
  if (portfolio.peakValueUsd > 0) {
    const drawdownPct =
      ((portfolio.peakValueUsd - portfolio.totalValueUsd) / portfolio.peakValueUsd) * 100;

    if (drawdownPct >= mandate.maxDrawdownPct) {
      violations.push(
        `HALT: Portfolio drawdown ${drawdownPct.toFixed(2)}% exceeds mandate limit of ${mandate.maxDrawdownPct}%. All trading blocked.`
      );
      blocked = true;
      return {
        decision: { ...decision, action: 'alert', trades: [], riskFlags: violations },
        violations,
        blocked,
      };
    }
  }

  // ── 2. Filter trades that violate rules ─────────────────────────────────────
  const approvedTrades = [];

  for (const trade of decision.trades ?? []) {
    const symbol = trade.asset?.toUpperCase();
    let tradeBlocked = false;

    // 2a. Market cap check
    if (mandate.minMarketCapUsd && symbol !== 'USDC') {
      const cap = market[symbol]?.marketCapUsd;
      if (cap != null && cap < mandate.minMarketCapUsd) {
        violations.push(
          `BLOCKED trade: ${symbol} market cap $${(cap / 1e6).toFixed(1)}M is below the ${mandate.riskTier} minimum of $${(mandate.minMarketCapUsd / 1e6).toFixed(0)}M.`
        );
        tradeBlocked = true;
      }
    }

    // 2b. Volume floor check (buys only) — prevents buying illiquid tokens
    if (!tradeBlocked && trade.type === 'buy' && mandate.minVolume24hUsd && symbol !== 'USDC') {
      const vol = market[symbol]?.volume24hUsd;
      if (vol != null && vol < mandate.minVolume24hUsd) {
        violations.push(
          `BLOCKED buy: ${symbol} 24h volume $${(vol / 1e6).toFixed(1)}M below ${(mandate.minVolume24hUsd / 1e6).toFixed(0)}M minimum.`
        );
        tradeBlocked = true;
      }
    }

    // 2c. Stop-loss re-entry cooldown — prevents buying back a recently stopped-out token
    if (!tradeBlocked && trade.type === 'buy' && symbol !== 'USDC') {
      if (isInStopCooldown(symbol)) {
        violations.push(
          `BLOCKED buy: ${symbol} is in stop-loss re-entry cooldown — too soon to re-enter after recent stop-out.`
        );
        tradeBlocked = true;
      }
    }

    // 2d. Cash floor check — ensure minCashPct is preserved after the buy
    if (!tradeBlocked && trade.type === 'buy' && mandate.minCashPct) {
      const cashFloor    = (mandate.minCashPct / 100) * portfolio.totalValueUsd;
      const availableCash = (portfolio.cashUsd ?? 0) - cashFloor;
      if (availableCash <= 0) {
        violations.push(
          `BLOCKED buy: USDC cash $${portfolio.cashUsd?.toFixed(2)} is at or below the ${mandate.minCashPct}% cash floor ($${cashFloor.toFixed(2)}) — preserving dry powder.`
        );
        tradeBlocked = true;
      } else if (trade.amountUsd > availableCash) {
        violations.push(
          `TRIMMED buy: ${symbol} reduced from $${trade.amountUsd} to $${availableCash.toFixed(2)} to preserve ${mandate.minCashPct}% cash floor.`
        );
        trade.amountUsd = parseFloat(availableCash.toFixed(2));
        trade.reason   += ` [trimmed to preserve cash floor]`;
      }
    }

    // 2f. Position size check (only for buys)
    if (!tradeBlocked && trade.type === 'buy') {
      const holdingAfterBuy = (portfolio.holdings.find(h => h.symbol === symbol)?.valueUsd ?? 0) + trade.amountUsd;
      const newAllocationPct = (holdingAfterBuy / portfolio.totalValueUsd) * 100;

      if (newAllocationPct > mandate.maxPositionPct) {
        const maxBuy = (mandate.maxPositionPct / 100) * portfolio.totalValueUsd -
          (portfolio.holdings.find(h => h.symbol === symbol)?.valueUsd ?? 0);

        if (maxBuy <= 0) {
          violations.push(
            `BLOCKED buy: ${symbol} already at or above max allocation of ${mandate.maxPositionPct}%.`
          );
          tradeBlocked = true;
        } else {
          violations.push(
            `TRIMMED buy: ${symbol} reduced from $${trade.amountUsd} to $${maxBuy.toFixed(2)} to respect ${mandate.maxPositionPct}% max allocation.`
          );
          trade.amountUsd = parseFloat(maxBuy.toFixed(2));
          trade.reason += ` [trimmed by mandate]`;
        }
      }
    }

    // 2g. Stop-loss trigger check (auto-sell if PnL below threshold)
    if (!tradeBlocked) {
      const holding = portfolio.holdings.find(h => h.symbol === symbol);
      if (holding && holding.pnlPct <= -mandate.stopLossPct) {
        violations.push(
          `STOP-LOSS: ${symbol} PnL of ${holding.pnlPct.toFixed(2)}% breached ${-mandate.stopLossPct}% threshold.`
        );
        // Force a sell if not already selling
        if (trade.type !== 'sell') {
          violations.push(`AUTO-CONVERTED to sell order for ${symbol} per stop-loss rule.`);
          trade.type = 'sell';
          trade.amountUsd = holding.valueUsd;
          trade.reason = `Mandatory stop-loss exit at ${holding.pnlPct.toFixed(2)}% PnL`;
        }
      }
    }

    if (!tradeBlocked) {
      approvedTrades.push(trade);
    }
  }

  // ── 3. Stop-loss scan: check all holdings, not just proposed trades ─────────
  for (const holding of portfolio.holdings) {
    if (holding.pnlPct <= -mandate.stopLossPct) {
      const alreadyHandled = approvedTrades.some(
        t => t.asset === holding.symbol && t.type === 'sell'
      );
      if (!alreadyHandled) {
        violations.push(
          `AUTO STOP-LOSS: ${holding.symbol} at ${holding.pnlPct.toFixed(2)}% — adding mandatory sell.`
        );
        approvedTrades.push({
          type: 'sell',
          asset: holding.symbol,
          amountUsd: holding.valueUsd,
          reason: `Mandatory stop-loss exit at ${holding.pnlPct.toFixed(2)}% PnL`,
        });
      }
    }
  }

  const finalAction = approvedTrades.length === 0 && decision.action !== 'hold' && decision.action !== 'alert'
    ? 'hold'
    : decision.action;

  return {
    decision: {
      ...decision,
      action: finalAction,
      trades: approvedTrades,
      riskFlags: [...(decision.riskFlags ?? []), ...violations],
    },
    violations,
    blocked,
  };
}

/**
 * Checks whether all stop-losses in the portfolio are currently triggered.
 * Useful for pre-flight checks before entering the reasoning loop.
 *
 * @param {object} portfolio
 * @param {object} mandate
 * @returns {string[]} List of triggered stop-loss messages
 */
export function scanStopLosses(portfolio, mandate) {
  return portfolio.holdings
    .filter(h => h.pnlPct <= -mandate.stopLossPct)
    .map(h => `${h.symbol}: ${h.pnlPct.toFixed(2)}% (threshold: -${mandate.stopLossPct}%)`);
}

/**
 * Scans all holdings for take-profit triggers.
 * Returns list of triggered messages for holdings where PnL >= takeProfitPct.
 */
export function scanTakeProfits(portfolio, mandate) {
  if (!mandate.takeProfitPct) return [];
  return portfolio.holdings
    .filter(h => h.symbol !== 'USDC' && h.pnlPct >= mandate.takeProfitPct)
    .map(h => `${h.symbol}: +${h.pnlPct.toFixed(2)}% (take-profit at +${mandate.takeProfitPct}%)`);
}
