// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — market/prices.js
// CoinGecko coins/markets API — free, no API key required
// Endpoint: https://api.coingecko.com/api/v3/coins/markets
// Returns price, 1h change, 24h change, volume, market cap in one call.
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL    = 'https://api.coingecko.com/api/v3/coins/markets';
const CACHE_TTL_MS = 30_000; // 30s — fast enough for live trading, safe with a CoinGecko API key

// CoinGecko coin ID for each supported Solana token symbol.
// Add tokens here to make them available for Claude to trade.
// Corresponding mint address + decimals must also be added to executor.js.
export const COINGECKO_IDS = {
  SOL:    'solana',
  USDC:   'usd-coin',
  JUP:    'jupiter-exchange-solana',
  BONK:   'bonk',
  WIF:    'dogwifcoin',
  JTO:    'jito-governance-token',
  PYTH:   'pyth-network',
  ORCA:   'orca',
  RAY:    'raydium',
  POPCAT: 'popcat',
  FARTCOIN: 'fartcoin',
  AI16Z:  'ai16z',
};

// All symbols Mercer can trade — used to fetch full market context for Claude
export const ALL_SUPPORTED_SYMBOLS = Object.keys(COINGECKO_IDS).filter(s => s !== 'USDC');

// In-memory cache keyed by sorted symbol list, e.g. "BONK,JUP,SOL,USDC,WIF"
// Each entry: { data, expiresAt }
// Stale entries are kept indefinitely so they can be served if CoinGecko rate-limits us.
const cache = new Map();

// Exponential backoff state — prevents hammering CoinGecko after a 429
let backoffUntil    = 0;
let backoffDuration = 60_000; // starts at 60s, doubles each consecutive 429, caps at 5min

/**
 * Fetches live market data for the requested token symbols from CoinGecko.
 * Uses /coins/markets to get 1h and 24h price changes in a single request.
 * Results are cached for 60 seconds per unique set of symbols.
 *
 * @param {string[]} symbols - Token symbols (must be in COINGECKO_IDS)
 * @returns {Promise<Record<string, {
 *   price: number,
 *   change1h: number | null,
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

  // Respect backoff — don't retry CoinGecko until the window expires
  if (Date.now() < backoffUntil) {
    const stale = cache.get(cacheKey);
    if (stale) return stale.data;
    return {};
  }

  const ids = symbols.map((s) => {
    const id = COINGECKO_IDS[s];
    if (!id) throw new Error(`No CoinGecko ID mapping for token: ${s}`);
    return id;
  });

  const url =
    `${BASE_URL}` +
    `?vs_currency=usd` +
    `&ids=${ids.join(',')}` +
    `&price_change_percentage=1h` +
    `&sparkline=false` +
    `&order=market_cap_desc`;

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
    // Set backoff FIRST on 429 — must happen regardless of whether stale cache exists,
    // otherwise the caller keeps retrying every interval and hammering the rate limit.
    if (res.status === 429) {
      backoffUntil    = Date.now() + backoffDuration;
      backoffDuration = Math.min(backoffDuration * 2, 300_000);
      const secs = Math.round(backoffUntil - Date.now()) / 1000;
      console.warn(`[Mercer] CoinGecko 429 — backing off ${secs}s`);
    }
    const stale = cache.get(cacheKey);
    if (stale) {
      if (res.status !== 429) {
        console.warn(`[Mercer] CoinGecko ${res.status} ${res.statusText} — serving stale prices`);
      }
      return stale.data;
    }
    if (res.status === 429) {
      return {};
    }
    throw new Error(`CoinGecko API ${res.status} ${res.statusText} fetching ${url}`);
  }

  const json = await res.json();

  // Build a lookup map from coin id → row
  const byId = {};
  for (const row of json) byId[row.id] = row;

  const market = {};
  for (const symbol of symbols) {
    const id   = COINGECKO_IDS[symbol];
    const data = byId[id];
    if (!data) throw new Error(`CoinGecko returned no data for ${symbol} (id: ${id})`);

    market[symbol] = {
      price:        data.current_price,
      change1h:     data.price_change_percentage_1h_in_currency ?? null,
      change24h:    data.price_change_percentage_24h             ?? null,
      volume24hUsd: data.total_volume                            ?? null,
      marketCapUsd: data.market_cap                              ?? null,
    };
  }

  cache.set(cacheKey, { data: market, expiresAt: Date.now() + CACHE_TTL_MS });
  backoffDuration = 60_000; // reset on success
  return market;
}
