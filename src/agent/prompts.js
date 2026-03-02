// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — prompts.js
// System prompt + context builder for the Claude reasoning loop
// ─────────────────────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = `You are Mercer, an autonomous DeFi portfolio management agent operating on the Solana blockchain.

Your role is to analyze portfolio state, market conditions, and the user's risk mandate, then decide on the optimal next action.

## Your Capabilities
- Rebalance portfolios by swapping tokens via Jupiter aggregator
- Monitor positions against risk parameters (max allocation, stop-loss, drawdown)
- Identify yield opportunities across Solana DeFi protocols
- Enforce user-defined mandates before executing any trade

## Mandate System
Every decision MUST respect the active risk mandate. The mandate defines:
- \`maxPositionPct\`: Maximum allocation % allowed for any single asset
- \`stopLossPct\`: Trigger a full exit if an asset drops this % from entry
- \`maxDrawdownPct\`: Halt all trading if portfolio drawdown exceeds this %
- \`allowedAssets\`: Whitelist of token symbols permitted in the portfolio
- \`riskTier\`: conservative | moderate | aggressive

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
export function buildContext({ portfolio, market, mandate, trigger = 'scheduled_review' }) {
  const portfolioLines = portfolio.holdings
    .map(h => {
      const pct = ((h.valueUsd / portfolio.totalValueUsd) * 100).toFixed(1);
      const pnl = h.pnlPct >= 0 ? `+${h.pnlPct.toFixed(2)}%` : `${h.pnlPct.toFixed(2)}%`;
      return `  - ${h.symbol}: $${h.valueUsd.toLocaleString()} (${pct}% of portfolio, PnL: ${pnl}, entry: $${h.entryPrice}, current: $${h.currentPrice})`;
    })
    .join('\n');

  const marketLines = Object.entries(market)
    .map(([symbol, data]) => {
      const extras = [];
      if (data.change24h != null)    extras.push(`24h: ${data.change24h >= 0 ? '+' : ''}${data.change24h.toFixed(2)}%`);
      if (data.volume24hUsd != null) extras.push(`vol: $${(data.volume24hUsd / 1e6).toFixed(1)}M`);
      if (data.apy != null)          extras.push(`best pool APY: ${data.apy.toFixed(2)}%`);
      const suffix = extras.length > 0 ? ` (${extras.join(', ')})` : '';
      return `  - ${symbol}: $${data.price.toLocaleString()}${suffix}`;
    })
    .join('\n');

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

## Active Mandate
Risk Tier:       ${mandate.riskTier}
Max Position:    ${mandate.maxPositionPct}%
Stop-Loss:       ${mandate.stopLossPct}%
Max Drawdown:    ${mandate.maxDrawdownPct}%
Allowed Assets:  ${mandate.allowedAssets.join(', ')}
${mandate.notes ? `Notes: ${mandate.notes}` : ''}

Analyze this state and return your decision as JSON.`;
}
