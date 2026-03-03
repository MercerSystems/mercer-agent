// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — market/prices.js
// CoinGecko simple/price API — free, no API key required
// Endpoint: https://api.coingecko.com/api/v3/simple/price
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.coingecko.com/api/v3/simple/price';
const CACHE_TTL_MS = 60_000;

// CoinGecko coin ID for each token symbol
const COINGECKO_IDS = {
  SOL:  'solana',
  USDC: 'usd-coin',
  JUP:  'jupiter-exchange-solana',
  BONK: 'bonk',
  WIF:  'dogwifcoin',
  JTO:  'jito-governance-token',
  PYTH: 'pyth-network',
};

// In-memory cache keyed by sorted symbol list, e.g. "BONK,JUP,SOL,USDC,WIF"
// Each entry: { data, expiresAt }
// Stale entries are kept indefinitely so they can be served if CoinGecko rate-limits us.
const cache = new Map();

/**
 * Fetches live market data for the requested token symbols from CoinGecko.
 * Results are cached for 60 seconds per unique set of symbols.
 *
 * @param {string[]} symbols - Token symbols (must be in COINGECKO_IDS)
 * @returns {Promise<Record<string, {
 *   price: number,
 *   change24h: number | null,
 *   volume24hUsd: number | null,
 *   marketCapUsd: number | null
 * }>>}
 */
export async function fetchMarketData(symbols = ['SOL', 'JUP', 'BONK', 'WIF', 'USDC']) {
  const cacheKey = [...symbols].sort().join(',');

  const cached = cache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  const ids = symbols.map((s) => {
    const id = COINGECKO_IDS[s];
    if (!id) throw new Error(`No CoinGecko ID mapping for token: ${s}`);
    return id;
  });

  const url =
    `${BASE_URL}` +
    `?ids=${ids.join(',')}` +
    `&vs_currencies=usd` +
    `&include_24hr_change=true` +
    `&include_24hr_vol=true` +
    `&include_market_cap=true`;

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    const stale = cache.get(cacheKey);
    if (stale) {
      console.warn(`[Mercer] CoinGecko network error — serving stale prices (${err.message})`);
      return stale.data;
    }
    throw new Error(`CoinGecko API network error fetching ${url} — ${err.message}`);
  }

  if (!res.ok) {
    const stale = cache.get(cacheKey);
    if (stale) {
      console.warn(`[Mercer] CoinGecko ${res.status} ${res.statusText} — serving stale prices`);
      return stale.data;
    }
    throw new Error(`CoinGecko API ${res.status} ${res.statusText} fetching ${url}`);
  }

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

  cache.set(cacheKey, { data: market, expiresAt: Date.now() + CACHE_TTL_MS });
  return market;
}
