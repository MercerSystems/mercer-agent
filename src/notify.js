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

export function tradeAlertText(trade, status) {
  const sign = trade.type === 'buy' ? '📈' : '📉';
  return `${sign} ${trade.type.toUpperCase()} ${trade.asset} $${trade.amountUsd?.toFixed(2)} [${status}]`;
}

export function stopLossAlertText(symbols) {
  return `🛑 Stop-loss triggered: ${symbols.join(', ')} — mandatory exits executed`;
}

export function takeProfitAlertText(symbols) {
  return `🎯 Take-profit triggered: ${symbols.join(', ')} — partial exits executed`;
}
