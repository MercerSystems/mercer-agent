// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — market/solana-market.js
// Fetches the top N Solana ecosystem tokens by market cap from CoinGecko.
// No hardcoded token list — dynamically discovers the best opportunities.
// Same backoff pattern as prices.js to handle CoinGecko rate limits.
// ─────────────────────────────────────────────────────────────────────────────

const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY ?? null;

const CATEGORY_URL =
  'https://api.coingecko.com/api/v3/coins/markets' +
  '?vs_currency=usd' +
  '&category=solana-ecosystem' +
  '&order=market_cap_desc' +
  '&per_page=200' +
  '&page=1' +
  '&price_change_percentage=1h';

function cgHeaders() {
  return COINGECKO_API_KEY ? { 'x-cg-demo-api-key': COINGECKO_API_KEY } : {};
}

// Stablecoin detection — filter these out of Claude's market view.
// Price pegged near $1 AND name/id contains a stablecoin keyword.
const STABLE_KEYWORDS = /usd|dai|eur|pax|tusd|frax|fdusd|pyusd|usdy|usyc|buidl|usdg|usdtb|syrup|ousg/i;

function isStablecoin(token) {
  if (token.symbol === 'USDC') return false; // always keep — it's our cash
  const priceNearPeg = token.price >= 0.95 && token.price <= 1.10;
  const nameIsStable = STABLE_KEYWORDS.test(token.name) || STABLE_KEYWORDS.test(token.coingeckoId);
  return priceNearPeg && nameIsStable;
}

const CACHE_TTL_MS = 120_000; // 2 min — ecosystem fetch is expensive, only used for reasoning cycles

let _cache           = null; // tradeable tokens only
let _cacheStables    = null; // stablecoins (kept separate)
let _cacheExpiry     = 0;
let _backoffUntil    = 0;
let _backoffDuration = 60_000;

/**
 * Fetches the top Solana ecosystem tokens by market cap.
 * Returns an array of token objects with price and market data.
 * Serves stale cache during rate-limit backoff.
 *
 * @param {number} [limit=25] - Max tokens to return
 * @returns {Promise<Array<{
 *   symbol: string,
 *   name: string,
 *   coingeckoId: string,
 *   price: number,
 *   change1h: number | null,
 *   change24h: number | null,
 *   volume24hUsd: number | null,
 *   marketCapUsd: number | null,
 * }>>}
 */
export async function fetchSolanaEcosystem(limit = 25) {
  if (_cache && Date.now() < _cacheExpiry) return _cache.slice(0, limit);

  if (Date.now() < _backoffUntil) {
    return (_cache ?? []).slice(0, limit);
  }

  let res;
  try {
    res = await fetch(CATEGORY_URL, { headers: cgHeaders() });
  } catch (err) {
    console.warn(`[Mercer] Solana ecosystem fetch network error: ${err.message}`);
    return (_cache ?? []).slice(0, limit);
  }

  if (!res.ok) {
    if (res.status === 429) {
      _backoffUntil    = Date.now() + _backoffDuration;
      _backoffDuration = Math.min(_backoffDuration * 2, 300_000);
      console.warn(`[Mercer] CoinGecko ecosystem 429 — backing off ${_backoffDuration / 1000}s`);
      return (_cache ?? []).slice(0, limit);
    }
    console.warn(`[Mercer] CoinGecko ecosystem ${res.status} ${res.statusText}`);
    return (_cache ?? []).slice(0, limit);
  }

  const json = await res.json();

  const all = json.map(coin => ({
    symbol:       coin.symbol.toUpperCase(),
    name:         coin.name,
    coingeckoId:  coin.id,
    price:        coin.current_price,
    change1h:     coin.price_change_percentage_1h_in_currency ?? null,
    change24h:    coin.price_change_percentage_24h             ?? null,
    volume24hUsd: coin.total_volume                            ?? null,
    marketCapUsd: coin.market_cap                              ?? null,
  }));

  // Separate tradeable tokens from stablecoins
  // Stablecoins are still cached but filtered from the default view
  _cache           = all.filter(t => !isStablecoin(t));
  _cacheStables    = all.filter(t => isStablecoin(t));
  _cacheExpiry     = Date.now() + CACHE_TTL_MS;
  _backoffDuration = 60_000; // reset on success
  return _cache.slice(0, limit);
}

/**
 * Converts the ecosystem array to a market map keyed by symbol.
 * Used by the reasoning context and watchdog.
 * If multiple tokens share a symbol, the higher market cap one wins.
 *
 * @param {number} [limit=25]
 * @returns {Promise<Record<string, object>>}
 */
export async function fetchSolanaMarketMap(limit = 25) {
  const tokens = await fetchSolanaEcosystem(limit);
  const map    = {};
  for (const t of tokens) {
    // Keep highest market cap if symbol collision
    if (!map[t.symbol] || (t.marketCapUsd ?? 0) > (map[t.symbol].marketCapUsd ?? 0)) {
      map[t.symbol] = t;
    }
  }
  return map;
}
