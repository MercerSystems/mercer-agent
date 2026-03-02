// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — market/coingecko.js
// CoinGecko simple/price API — free, no API key required
// Returns price, 24h change %, 24h volume, and market cap
// Docs: https://docs.coingecko.com/reference/simple-price
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.coingecko.com/api/v3';

// CoinGecko coin ID for each Solana token symbol
const COINGECKO_IDS = {
  SOL:  'solana',
  JUP:  'jupiter-exchange-solana',
  BONK: 'bonk',
  WIF:  'dogwifcoin',
  USDC: 'usd-coin',
  JTO:  'jito-governance-token',
  PYTH: 'pyth-network',
};

/**
 * Fetches live market data for the requested token symbols from CoinGecko.
 *
 * @param {string[]} symbols - Token symbols (must be in COINGECKO_IDS)
 * @returns {Promise<Record<string, {
 *   price: number,
 *   change24h: number,
 *   volume24hUsd: number,
 *   marketCapUsd: number
 * }>>}
 */
export async function fetchMarketData(symbols = ['SOL', 'JUP', 'BONK', 'WIF', 'USDC']) {
  const ids = symbols.map((s) => {
    const id = COINGECKO_IDS[s];
    if (!id) throw new Error(`No CoinGecko ID mapping for token: ${s}`);
    return id;
  });

  const url =
    `${BASE_URL}/simple/price` +
    `?ids=${ids.join(',')}` +
    `&vs_currencies=usd` +
    `&include_24hr_change=true` +
    `&include_24hr_vol=true` +
    `&include_market_cap=true`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko API ${res.status}: ${res.statusText}`);

  const json = await res.json();

  const market = {};
  for (const symbol of symbols) {
    const id   = COINGECKO_IDS[symbol];
    const data = json[id];
    if (!data) throw new Error(`CoinGecko returned no data for ${symbol} (id: ${id})`);

    market[symbol] = {
      price:        data.usd,
      change24h:    data.usd_24h_change  ?? null,
      volume24hUsd: data.usd_24h_vol     ?? null,
      marketCapUsd: data.usd_market_cap  ?? null,
    };
  }

  return market;
}
