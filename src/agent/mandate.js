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
    maxPositionPct:      35,
    stopLossPct:         15,   // standard stop for mid/large cap
    microCapStopLossPct: 10,   // tighter stop for tokens < $5M market cap
    microCapThresholdUsd: 5_000_000,
    trailingStopPct:     10,
    takeProfitPct:       60,
    takeProfitLadder: [
      { pct: 12, sellFraction: 0.33 },
      { pct: 30, sellFraction: 0.33 },
      { pct: 60, sellFraction: 0.34 },
    ],
    maxDrawdownPct:   25,
    minCashPct:       20,
    minMarketCapUsd:  1_000_000,
    minVolume24hUsd:    500_000,
    notes: 'Small-cap momentum discovery. Primary focus: micro and small-cap Solana tokens ($1M–$20M) gaining traction. Fast entries, fast exits. Build the portfolio through asymmetric small-cap wins — shift to large caps once portfolio exceeds $2K.',
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
import { isBuyBlocked } from './blocked-buys.js';

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
    const isSwap   = trade.type === 'swap';
    // For buy/sell: symbol is trade.asset. For swap: check toAsset (entry side) and fromAsset (exit side).
    const symbol     = isSwap ? trade.toAsset?.toUpperCase()   : trade.asset?.toUpperCase();
    const fromSymbol = isSwap ? trade.fromAsset?.toUpperCase() : null;
    let tradeBlocked = false;

    // 2a-0. SOL is gas-only — never a tradeable position
    if (symbol === 'SOL' || fromSymbol === 'SOL') {
      violations.push(`BLOCKED ${trade.type}: SOL is reserved for gas fees and is not a tradeable position.`);
      tradeBlocked = true;
    }

    // 2a. Market cap check — applied to the token being entered (symbol / toAsset)
    if (!tradeBlocked && mandate.minMarketCapUsd && symbol !== 'USDC') {
      const cap = market[symbol]?.marketCapUsd;
      if (cap != null && cap < mandate.minMarketCapUsd) {
        violations.push(
          `BLOCKED trade: ${symbol} market cap $${(cap / 1e6).toFixed(1)}M is below the ${mandate.riskTier} minimum of $${(mandate.minMarketCapUsd / 1e6).toFixed(0)}M.`
        );
        tradeBlocked = true;
      }
    }

    // 2b. Volume floor check (buys and swaps) — prevents entering illiquid tokens
    if (!tradeBlocked && (trade.type === 'buy' || isSwap) && mandate.minVolume24hUsd && symbol !== 'USDC') {
      const vol = market[symbol]?.volume24hUsd;
      if (vol != null && vol < mandate.minVolume24hUsd) {
        violations.push(
          `BLOCKED ${trade.type}: ${symbol} 24h volume $${(vol / 1e6).toFixed(1)}M below ${(mandate.minVolume24hUsd / 1e6).toFixed(0)}M minimum.`
        );
        tradeBlocked = true;
      }
    }

    // 2c. Stop-loss re-entry cooldown — prevents buying back a recently stopped-out token
    if (!tradeBlocked && (trade.type === 'buy' || isSwap) && symbol !== 'USDC') {
      if (isInStopCooldown(symbol)) {
        violations.push(
          `BLOCKED ${trade.type}: ${symbol} is in stop-loss re-entry cooldown — too soon to re-enter after recent stop-out.`
        );
        tradeBlocked = true;
      }
    }

    // 2c-2. Permanent buy block — user-defined symbols that should never be bought
    if (!tradeBlocked && (trade.type === 'buy' || isSwap) && symbol !== 'USDC') {
      if (isBuyBlocked(symbol)) {
        violations.push(
          `BLOCKED ${trade.type}: ${symbol} is on the permanent buy block list (data/blocked-buys.json).`
        );
        tradeBlocked = true;
      }
    }

    // 2d. Cash floor check — only applies to buys (swaps don't spend USDC)
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

    // 2f. Position size check (buys and swaps — check the token being entered)
    if (!tradeBlocked && (trade.type === 'buy' || isSwap)) {
      const holdingAfterBuy = (portfolio.holdings.find(h => h.symbol === symbol)?.valueUsd ?? 0) + trade.amountUsd;
      const newAllocationPct = (holdingAfterBuy / portfolio.totalValueUsd) * 100;

      if (newAllocationPct > mandate.maxPositionPct) {
        const maxBuy = (mandate.maxPositionPct / 100) * portfolio.totalValueUsd -
          (portfolio.holdings.find(h => h.symbol === symbol)?.valueUsd ?? 0);

        if (maxBuy <= 0) {
          violations.push(
            `BLOCKED ${trade.type}: ${symbol} already at or above max allocation of ${mandate.maxPositionPct}%.`
          );
          tradeBlocked = true;
        } else {
          violations.push(
            `TRIMMED ${trade.type}: ${symbol} reduced from $${trade.amountUsd} to $${maxBuy.toFixed(2)} to respect ${mandate.maxPositionPct}% max allocation.`
          );
          trade.amountUsd = parseFloat(maxBuy.toFixed(2));
          trade.reason += ` [trimmed by mandate]`;
        }
      }
    }

    // 2g. Stop-loss trigger check — applies to the asset being exited
    // For buy/sell use symbol; for swap use fromSymbol (the exit side)
    if (!tradeBlocked) {
      const exitSymbol = isSwap ? fromSymbol : symbol;
      const holding = portfolio.holdings.find(h => h.symbol === exitSymbol);
      if (holding) {
        const cap        = market[exitSymbol]?.marketCapUsd ?? Infinity;
        const isMicroCap = mandate.microCapThresholdUsd && cap < mandate.microCapThresholdUsd;
        const stopPct    = isMicroCap && mandate.microCapStopLossPct
          ? mandate.microCapStopLossPct
          : mandate.stopLossPct;

        if (holding.pnlPct <= -stopPct) {
          violations.push(
            `STOP-LOSS: ${exitSymbol} PnL of ${holding.pnlPct.toFixed(2)}% breached ${-stopPct}% threshold${isMicroCap ? ' (micro-cap)' : ''}.`
          );
          if (trade.type === 'buy') {
            violations.push(`AUTO-CONVERTED to sell order for ${exitSymbol} per stop-loss rule.`);
            trade.type = 'sell';
            trade.asset = exitSymbol;
            trade.amountUsd = holding.valueUsd;
            trade.reason = `Mandatory stop-loss exit at ${holding.pnlPct.toFixed(2)}% PnL`;
          }
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
export function scanStopLosses(portfolio, mandate, market = {}) {
  return portfolio.holdings
    .filter(h => {
      const cap        = market[h.symbol]?.marketCapUsd ?? Infinity;
      const isMicroCap = mandate.microCapThresholdUsd && cap < mandate.microCapThresholdUsd;
      const stopPct    = isMicroCap && mandate.microCapStopLossPct
        ? mandate.microCapStopLossPct
        : mandate.stopLossPct;
      return h.pnlPct <= -stopPct;
    })
    .map(h => {
      const cap        = market[h.symbol]?.marketCapUsd ?? Infinity;
      const isMicroCap = mandate.microCapThresholdUsd && cap < mandate.microCapThresholdUsd;
      const stopPct    = isMicroCap && mandate.microCapStopLossPct
        ? mandate.microCapStopLossPct
        : mandate.stopLossPct;
      return `${h.symbol}: ${h.pnlPct.toFixed(2)}% (threshold: -${stopPct}%${isMicroCap ? ', micro-cap' : ''})`;
    });
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
