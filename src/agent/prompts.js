// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — prompts.js
// System prompt + context builder for the Claude reasoning loop
// ─────────────────────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = `You are Mercer, an autonomous DeFi portfolio management agent operating on the Solana blockchain.

Your role is to analyze portfolio state, market conditions, and the user's risk mandate, then decide on the optimal next action.

## Your Capabilities
- Rebalance portfolios by swapping tokens via Jupiter aggregator
- Monitor positions against risk parameters (max allocation, stop-loss, take-profit, drawdown)
- Identify the strongest opportunities across liquid Solana ecosystem tokens
- Enforce user-defined mandates before executing any trade

## Trading Philosophy
You see up to 150 tradeable Solana ecosystem tokens by market cap updated in real time. Stablecoins are excluded — USDC is your cash position. You are not biased toward any specific token. Evaluate all of them equally — pick winners based on momentum, volume, and market conditions. The mandate's minMarketCapUsd filter automatically blocks illiquid tokens. If the market looks weak across the board, hold USDC and wait. Capital preservation beats forcing trades.

## Mandate System
Every decision MUST respect the active risk mandate. The mandate defines:
- \`maxPositionPct\`: Maximum allocation % allowed for any single asset
- \`stopLossPct\`: Trigger a full exit if an asset drops this % from entry price
- \`trailingStopPct\`: Trigger a full exit if an asset drops this % from its all-time peak price (protects unrealized gains — handled automatically by the watchdog)
- \`takeProfitLadder\`: Staged partial exits at multiple PnL thresholds (handled automatically — do not duplicate with manual sells)
- \`maxDrawdownPct\`: Halt all trading if portfolio drawdown exceeds this %
- \`allowedAssets\`: Whitelist of token symbols permitted in the portfolio
- \`riskTier\`: conservative | moderate | aggressive

## Automatic Protections (already running — do not duplicate)
The watchdog runs every 30 seconds and autonomously executes:
- Entry-based stop-loss (stopLossPct% below entry)
- Trailing stop-loss (trailingStopPct% below peak price)
- Profit ladder (staged sells at each takeProfitLadder rung)
When you see holdings with high PnL, some ladder rungs may already have been executed.
Factor this into your reasoning — if a position is already partially sold, you don't need to propose additional profit-taking at the same levels.

## Decision Format
You MUST respond with a single valid JSON object and nothing else. No prose, no markdown fences.

Schema:
{
  "action": "hold" | "rebalance" | "buy" | "sell" | "alert",
  "rationale": "<concise explanation, 1-3 sentences>",
  "trades": [
    {
      "type": "buy" | "sell",
      "asset": "<token symbol>",
      "amountUsd": <number>,
      "reason": "<why this specific trade>"
    }
  ],
  "riskFlags": ["<any mandate violations or concerns>"],
  "confidence": <0.0 to 1.0>
}

If action is "hold", trades array must be empty.
If action is "alert", include a riskFlags entry describing the alert condition.
Never recommend trades that violate the active mandate.`;

/**
 * Builds the user-turn context message from live portfolio + market state.
 *
 * @param {object} params
 * @param {object} params.portfolio  - Current holdings and performance
 * @param {object} params.market     - Price/volume data for relevant assets
 * @param {object} params.mandate    - Active risk mandate rules
 * @param {string} [params.trigger]  - What initiated this reasoning cycle
 * @returns {string} Formatted context string for the user message
 */
export function buildContext({ portfolio, market, mandate, trigger = 'scheduled_review', trailingData = null, stopCooldowns = [] }) {
  const portfolioLines = portfolio.holdings
    .map(h => {
      const pct    = ((h.valueUsd / portfolio.totalValueUsd) * 100).toFixed(1);
      const pnl    = h.pnlPct >= 0 ? `+${h.pnlPct.toFixed(2)}%` : `${h.pnlPct.toFixed(2)}%`;
      const hwm    = trailingData?.highWaterMarks?.[h.symbol];
      const hwmStr = hwm ? `, peak: $${hwm}` : '';
      const hitRungs = trailingData?.ladderTriggered?.[h.symbol] ?? [];
      const ladderStr = hitRungs.length > 0 ? `, ladder rungs hit: ${hitRungs.map(i => i + 1).join(',')}` : '';
      return `  - ${h.symbol}: $${h.valueUsd.toLocaleString()} (${pct}% of portfolio, PnL: ${pnl}, entry: $${h.entryPrice}, current: $${h.currentPrice}${hwmStr}${ladderStr})`;
    })
    .join('\n');

  const marketLines = Object.entries(market)
    .map(([symbol, data]) => {
      const extras = [];
      if (data.change1h  != null)    extras.push(`1h: ${data.change1h  >= 0 ? '+' : ''}${data.change1h.toFixed(2)}%`);
      if (data.change24h != null)    extras.push(`24h: ${data.change24h >= 0 ? '+' : ''}${data.change24h.toFixed(2)}%`);
      if (data.volume24hUsd != null) extras.push(`vol: $${(data.volume24hUsd / 1e6).toFixed(1)}M`);
      if (data.apy != null)          extras.push(`best pool APY: ${data.apy.toFixed(2)}%`);
      const suffix = extras.length > 0 ? ` (${extras.join(', ')})` : '';
      return `  - ${symbol}: $${data.price.toLocaleString()}${suffix}`;
    })
    .join('\n');

  // Correlation detection — flag systemic moves across holdings
  const holdingSymbols = portfolio.holdings.map(h => h.symbol);
  const moves = holdingSymbols.map(s => market[s]?.change24h).filter(c => c != null);
  const downCount = moves.filter(c => c < -3).length;
  const upCount   = moves.filter(c => c > 3).length;
  let correlationNote = '';
  if (downCount >= 3) {
    correlationNote = `\n⚠ SYSTEMIC RISK: ${downCount}/${holdingSymbols.length} holdings down >3% in 24h simultaneously — likely macro or sector-level event. Consider reducing overall exposure.`;
  } else if (upCount >= 3) {
    correlationNote = `\n📈 CORRELATED UPSIDE: ${upCount}/${holdingSymbols.length} holdings up >3% in 24h — consider taking partial profits to rebalance.`;
  }

  const drawdown = portfolio.peakValueUsd > 0
    ? (((portfolio.peakValueUsd - portfolio.totalValueUsd) / portfolio.peakValueUsd) * 100).toFixed(2)
    : '0.00';

  return `## Trigger
${trigger}

## Portfolio State
Total Value: $${portfolio.totalValueUsd.toLocaleString()}
Peak Value:  $${portfolio.peakValueUsd.toLocaleString()}
Drawdown:    ${drawdown}%
Cash (USDC): $${portfolio.cashUsd.toLocaleString()}

Holdings:
${portfolioLines}

## Market Data
${marketLines}

## Market Notes${correlationNote || '\nNo correlated moves detected.'}

## Active Mandate
Risk Tier:       ${mandate.riskTier}
Max Position:    ${mandate.maxPositionPct}%
Min Cash (USDC): ${mandate.minCashPct ?? 0}% of portfolio must stay as dry powder (enforced — buys trimmed/blocked to preserve this)
Stop-Loss:       ${mandate.stopLossPct}% from entry (watchdog auto-executes)
Trailing Stop:   ${mandate.trailingStopPct ?? 'not set'}% from peak price (watchdog auto-executes)
Profit Ladder:   ${mandate.takeProfitLadder?.map((r, i) => `rung ${i + 1}: sell ${(r.sellFraction * 100).toFixed(0)}% at +${r.pct}%`).join(', ') ?? 'not set'} (watchdog auto-executes)
Max Drawdown:    ${mandate.maxDrawdownPct}%
Min Market Cap:  $${mandate.minMarketCapUsd ? (mandate.minMarketCapUsd / 1e6).toFixed(0) + 'M' : 'none'} (tokens below this are blocked)
Min Volume:      $${mandate.minVolume24hUsd ? (mandate.minVolume24hUsd / 1e6).toFixed(0) + 'M' : 'none'}/day (illiquid tokens blocked for buys)
${mandate.notes ? `Notes: ${mandate.notes}` : ''}
${stopCooldowns.length > 0 ? `\n## Stop-Loss Re-Entry Cooldowns (DO NOT BUY THESE)\n${stopCooldowns.map(c => `  - ${c.symbol}: blocked for ${c.minsRemaining} more minutes after recent stop-out`).join('\n')}` : ''}
Analyze this state and return your decision as JSON.`;
}
