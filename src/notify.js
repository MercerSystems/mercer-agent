// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — notify.js
// Discord webhook alerts — add DISCORD_WEBHOOK_URL to .env
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sends a message to the configured Discord webhook.
 * Silently no-ops if DISCORD_WEBHOOK_URL is not set.
 */
export async function sendAlert(message) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content: `**Mercer** ${message}` }),
    });
  } catch (err) {
    console.warn('[Mercer] Discord alert failed:', err.message);
  }
}

export function tradeAlertText(trade, status, { entryPrice, portfolioTotal } = {}) {
  const isSell = trade.type === 'sell' || (trade.type === 'swap');
  const sign   = trade.type === 'buy' ? '📈' : isSell ? '📉' : '🔄';
  const symbol = trade.type === 'swap'
    ? `${trade.fromAsset}→${trade.toAsset}`
    : trade.asset;

  let pnlStr = '';
  if (isSell && entryPrice && trade.type !== 'swap') {
    const currentPrice = trade.amountUsd && trade.quantity ? trade.amountUsd / trade.quantity : null;
    const pnlPct = currentPrice && entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : null;
    if (pnlPct != null) pnlStr = ` | PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;
  }

  const portfolioStr = portfolioTotal ? ` | Portfolio: $${portfolioTotal.toFixed(2)}` : '';
  return `${sign} ${trade.type.toUpperCase()} ${symbol} $${trade.amountUsd?.toFixed(2)} [${status}]${pnlStr}${portfolioStr}`;
}

export function stopLossAlertText(symbols) {
  return `🛑 Stop-loss triggered: ${symbols.join(', ')} — mandatory exits executed`;
}

export function takeProfitAlertText(symbols) {
  return `🎯 Take-profit triggered: ${symbols.join(', ')} — partial exits executed`;
}
