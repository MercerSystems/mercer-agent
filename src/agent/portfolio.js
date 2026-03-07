// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — agent/portfolio.js
// Shared portfolio constants and builder — used by both CLI (index.js) and API
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_BASE_PORTFOLIO = {
  walletAddress: 'MockWallet1111111111111111111111111111111111',
  peakValueUsd: 0,
  cashUsd: 5_000,
  holdings: [
    { symbol: 'SOL',  quantity: 149.33,      entryPrice: 81.46      },
    { symbol: 'JUP',  quantity: 11_150,      entryPrice: 0.152383   },
    { symbol: 'BONK', quantity: 310_000_000, entryPrice: 0.00000591 },
    { symbol: 'WIF',  quantity: 1_920,       entryPrice: 0.200653   },
  ],
};

/**
 * Applies live market prices to a base portfolio to calculate position values and PnL.
 *
 * @param {object} base   - Base portfolio with holdings (quantities + entry prices)
 * @param {object} market - Market data snapshot from fetchMarketData()
 * @returns {object} Enriched portfolio with currentPrice, valueUsd, pnlPct, totalValueUsd
 */
export function buildLivePortfolio(base, market) {
  const holdings = base.holdings.map((h) => {
    const currentPrice = market[h.symbol]?.price ?? h.entryPrice ?? 0;
    const valueUsd     = currentPrice * h.quantity;
    const pnlPct       = h.entryPrice > 0
      ? ((currentPrice - h.entryPrice) / h.entryPrice) * 100
      : 0;
    const unpriced     = !market[h.symbol]?.price && !h.entryPrice;
    return { ...h, currentPrice, valueUsd, pnlPct, unpriced };
  });

  // cashUsd = explicit base cash + any USDC held as an SPL token.
  // Live wallets return cashUsd:0 with USDC inside holdings; mock portfolios
  // carry cashUsd directly with no USDC holding. Both paths land here correctly.
  const usdcHolding = holdings.find(h => h.symbol === 'USDC');
  const cashUsd     = (base.cashUsd ?? 0) + (usdcHolding?.valueUsd ?? 0);

  const totalValueUsd = holdings.reduce((sum, h) => sum + h.valueUsd, 0) + (base.cashUsd ?? 0);

  // Seed peak from current value if not set, so drawdown starts at 0%
  const peakValueUsd = base.peakValueUsd > 0 ? base.peakValueUsd : totalValueUsd;

  return { ...base, holdings, cashUsd, totalValueUsd, peakValueUsd };
}
