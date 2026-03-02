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
    maxPositionPct: 20,       // No single asset > 20% of portfolio
    stopLossPct: 10,          // Exit if asset drops 10% from entry
    maxDrawdownPct: 15,       // Halt trading if portfolio down 15% from peak
    allowedAssets: ['SOL', 'USDC', 'JTO', 'JITO'],
    notes: 'Capital preservation priority. Avoid high-volatility meme tokens.',
  },
  moderate: {
    riskTier: 'moderate',
    maxPositionPct: 35,
    stopLossPct: 20,
    maxDrawdownPct: 25,
    allowedAssets: ['SOL', 'USDC', 'JTO', 'JITO', 'BONK', 'WIF', 'JUP', 'PYTH'],
    notes: 'Balanced growth and protection. Allow mid-cap Solana ecosystem tokens.',
  },
  aggressive: {
    riskTier: 'aggressive',
    maxPositionPct: 50,
    stopLossPct: 35,
    maxDrawdownPct: 40,
    allowedAssets: ['SOL', 'USDC', 'JTO', 'JITO', 'BONK', 'WIF', 'JUP', 'PYTH', 'MEME', 'BOME', 'POPCAT'],
    notes: 'High risk/reward. Meme tokens and micro-caps permitted.',
  },
};

/**
 * Checks a Claude-generated decision against the active mandate.
 * Returns a validated (and potentially pruned) decision with any violations flagged.
 *
 * @param {object} decision  - Raw decision object from Claude
 * @param {object} mandate   - Active risk mandate
 * @param {object} portfolio - Current portfolio state
 * @returns {{ decision: object, violations: string[], blocked: boolean }}
 */
export function enforceMandate(decision, mandate, portfolio) {
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

    // 2a. Asset whitelist check
    if (!mandate.allowedAssets.map(a => a.toUpperCase()).includes(symbol)) {
      violations.push(`BLOCKED trade: ${symbol} is not in the allowed asset list for ${mandate.riskTier} mandate.`);
      tradeBlocked = true;
    }

    // 2b. Position size check (only for buys)
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

    // 2c. Stop-loss trigger check (auto-sell if PnL below threshold)
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
