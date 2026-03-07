// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — market/solana-market.js
// Fetches the top N Solana ecosystem tokens by market cap from CoinGecko.
// No hardcoded token list — dynamically discovers the best opportunities.
// Same backoff pattern as prices.js to handle CoinGecko rate limits.
// ─────────────────────────────────────────────────────────────────────────────

const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY ?? null;

const CATEGORY_BASE =
  'https://api.coingecko.com/api/v3/coins/markets' +
  '?vs_currency=usd' +
  '&category=solana-ecosystem' +
  '&order=market_cap_desc' +
  '&per_page=250' +
  '&price_change_percentage=1h,7d';

const CATEGORY_URL   = CATEGORY_BASE + '&page=1';
const CATEGORY_URL_2 = CATEGORY_BASE + '&page=2';

// Volume-sorted fetch — surfaces new/trending tokens that rank low by market cap
// but are getting heavy attention right now. Best signal for early-stage launches.
const VOLUME_SORT_URL =
  'https://api.coingecko.com/api/v3/coins/markets' +
  '?vs_currency=usd' +
  '&category=solana-ecosystem' +
  '&order=volume_desc' +
  '&per_page=75' +
  '&price_change_percentage=1h,7d';

function cgHeaders() {
  return COINGECKO_API_KEY ? { 'x-cg-demo-api-key': COINGECKO_API_KEY } : {};
}

import { updateVolumeBaseline } from './volume-tracker.js';

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

// Tokens held by Mercer that aren't in CoinGecko's solana-ecosystem category.
// These get fetched separately and merged into the market map so they show prices.
const SUPPLEMENTAL_IDS = [
  'aixbt',        // AIXBT    — categorised as Base/ETH on CoinGecko
  'audius',       // AUDIO    — Ethereum-primary, has Solana SPL bridge token
  'comedian',     // BAN      — Solana meme coin (CoinGecko id: comedian)
  'war',          // WAR      — Solana token
  'bio-protocol', // BIO      — DeSci token on Solana
];

let _cache           = null; // page 1 tradeable tokens (ranks 1-250)
let _cacheStables    = null; // stablecoins (kept separate)
let _cacheExpiry     = 0;
let _backoffUntil    = 0;
let _backoffDuration = 60_000;

// Page 2 state — tokens ranked 251-500 by market cap, fetched only when limit > 250
let _cache2           = null;
let _cacheExpiry2     = 0;
let _backoff2Until    = 0;
let _backoff2Duration = 60_000;

// Volume-sort cache — top 75 by 24h volume, catches new launches the market cap sort misses
let _volCache         = null;
let _volExpiry        = 0;
let _volBackoffUntil  = 0;
let _volBackoffDur    = 60_000;

let _suppCache        = null; // supplemental token map (symbol → token)
let _suppExpiry       = 0;
let _suppBackoffUntil = 0;   // don't retry supplemental fetch until this time

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
  const needsPage2 = limit > 250;

  // Serve page 1 from cache if fresh
  const p1Fresh = _cache && Date.now() < _cacheExpiry;

  if (!p1Fresh) {
    if (Date.now() < _backoffUntil) {
      const stale = [...(_cache ?? []), ...(_cache2 ?? [])];
      return stale.slice(0, limit);
    }

    let res;
    try {
      res = await fetch(CATEGORY_URL, { headers: cgHeaders() });
    } catch (err) {
      console.warn(`[Mercer] Solana ecosystem fetch network error: ${err.message}`);
      const stale = [...(_cache ?? []), ...(_cache2 ?? [])];
      return stale.slice(0, limit);
    }

    if (!res.ok) {
      if (res.status === 429) {
        _backoffUntil    = Date.now() + _backoffDuration;
        _backoffDuration = Math.min(_backoffDuration * 2, 300_000);
        console.warn(`[Mercer] CoinGecko ecosystem 429 — backing off ${_backoffDuration / 1000}s`);
        const stale = [...(_cache ?? []), ...(_cache2 ?? [])];
        return stale.slice(0, limit);
      }
      console.warn(`[Mercer] CoinGecko ecosystem ${res.status} ${res.statusText}`);
      const stale = [...(_cache ?? []), ...(_cache2 ?? [])];
      return stale.slice(0, limit);
    }

    const json = await res.json();
    const all  = json.map(coin => ({
      symbol:       coin.symbol.toUpperCase(),
      name:         coin.name,
      coingeckoId:  coin.id,
      price:        coin.current_price,
      change1h:     coin.price_change_percentage_1h_in_currency ?? null,
      change24h:    coin.price_change_percentage_24h             ?? null,
      change7d:     coin.price_change_percentage_7d_in_currency ?? null,
      volume24hUsd: coin.total_volume                           ?? null,
      marketCapUsd: coin.market_cap                             ?? null,
    }));

    _cache           = all.filter(t => !isStablecoin(t));
    _cacheStables    = all.filter(t =>  isStablecoin(t));
    _cacheExpiry     = Date.now() + CACHE_TTL_MS;
    _backoffDuration = 60_000; // reset on success
    updateVolumeBaseline(_cache);
  }

  // Page 2 — only fetched when the caller needs tokens beyond rank 250
  if (needsPage2 && !(_cache2 && Date.now() < _cacheExpiry2) && Date.now() > _backoff2Until) {
    try {
      const res2 = await fetch(CATEGORY_URL_2, { headers: cgHeaders() });
      if (res2.ok) {
        const json2 = await res2.json();
        _cache2 = json2
          .map(coin => ({
            symbol:       coin.symbol.toUpperCase(),
            name:         coin.name,
            coingeckoId:  coin.id,
            price:        coin.current_price,
            change1h:     coin.price_change_percentage_1h_in_currency ?? null,
            change24h:    coin.price_change_percentage_24h             ?? null,
            change7d:     coin.price_change_percentage_7d_in_currency ?? null,
            volume24hUsd: coin.total_volume                           ?? null,
            marketCapUsd: coin.market_cap                             ?? null,
          }))
          .filter(t => !isStablecoin(t));
        _cacheExpiry2     = Date.now() + CACHE_TTL_MS;
        _backoff2Duration = 60_000;
      } else if (res2.status === 429) {
        _backoff2Until    = Date.now() + _backoff2Duration;
        _backoff2Duration = Math.min(_backoff2Duration * 2, 300_000);
        console.warn(`[Mercer] CoinGecko ecosystem p2 429 — backing off ${_backoff2Duration / 1000}s`);
      }
    } catch (err) {
      _backoff2Until = Date.now() + 30_000;
      console.warn(`[Mercer] Solana ecosystem page 2 fetch error: ${err.message}`);
    }
  }

  const combined = needsPage2
    ? [...(_cache ?? []), ...(_cache2 ?? [])]
    : (_cache ?? []);

  return combined.slice(0, limit);
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

  // Fetch supplemental tokens (held but not in solana-ecosystem category)
  // Use cached results if still fresh
  if (_suppCache && Date.now() < _suppExpiry) {
    for (const [sym, t] of Object.entries(_suppCache)) {
      if (!map[sym]) map[sym] = t;
    }
    return map;
  }

  const missing = SUPPLEMENTAL_IDS.filter(
    id => !Object.values(map).some(t => t.coingeckoId === id)
  );
  if (missing.length > 0 && Date.now() > _suppBackoffUntil) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6_000);
    try {
      const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${missing.join(',')}&price_change_percentage=1h`;
      const res = await fetch(url, { headers: cgHeaders(), signal: controller.signal });
      if (res.ok) {
        const json  = await res.json();
        _suppCache  = _suppCache ?? {};
        for (const coin of json) {
          const t = {
            symbol:       coin.symbol.toUpperCase(),
            name:         coin.name,
            coingeckoId:  coin.id,
            price:        coin.current_price,
            change1h:     coin.price_change_percentage_1h_in_currency ?? null,
            change24h:    coin.price_change_percentage_24h             ?? null,
            change7d:     coin.price_change_percentage_7d_in_currency ?? null,
            volume24hUsd: coin.total_volume                           ?? null,
            marketCapUsd: coin.market_cap                             ?? null,
          };
          _suppCache[t.symbol] = t;
          if (!map[t.symbol]) map[t.symbol] = t;
        }
        _suppExpiry = Date.now() + CACHE_TTL_MS;
      } else {
        _suppBackoffUntil = Date.now() + 60_000; // back off 60s on non-OK response
      }
    } catch {
      _suppBackoffUntil = Date.now() + 30_000; // back off 30s on timeout/network error
    } finally {
      clearTimeout(t);
    }
  } else if (_suppCache) {
    // Serve stale supplemental cache while in backoff
    for (const [sym, tok] of Object.entries(_suppCache)) {
      if (!map[sym]) map[sym] = tok;
    }
  }

  // ── Volume-sorted fetch — catches new launches & trending tokens ────────────
  // Tokens ranked low by market cap but high by volume are early-stage momentum plays.
  // Merged into the map so Claude can see them; flagged via high turnover ratio.
  if (_volCache && Date.now() < _volExpiry) {
    for (const t of _volCache) {
      if (!map[t.symbol]) map[t.symbol] = { ...t, fromVolSort: true };
    }
  } else if (Date.now() > _volBackoffUntil) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(VOLUME_SORT_URL, { headers: cgHeaders(), signal: controller.signal });
      if (res.ok) {
        const json = await res.json();
        _volCache = json
          .map(coin => ({
            symbol:       coin.symbol.toUpperCase(),
            name:         coin.name,
            coingeckoId:  coin.id,
            price:        coin.current_price,
            change1h:     coin.price_change_percentage_1h_in_currency ?? null,
            change24h:    coin.price_change_percentage_24h             ?? null,
            change7d:     coin.price_change_percentage_7d_in_currency ?? null,
            volume24hUsd: coin.total_volume                           ?? null,
            marketCapUsd: coin.market_cap                             ?? null,
            fromVolSort:  true, // tag so Claude's context can identify these
          }))
          .filter(t => !isStablecoin(t));
        _volExpiry    = Date.now() + CACHE_TTL_MS;
        _volBackoffDur = 60_000;
        for (const t of _volCache) {
          if (!map[t.symbol]) map[t.symbol] = t;
        }
      } else if (res.status === 429) {
        _volBackoffUntil = Date.now() + _volBackoffDur;
        _volBackoffDur   = Math.min(_volBackoffDur * 2, 300_000);
      } else {
        _volBackoffUntil = Date.now() + 60_000;
      }
    } catch {
      _volBackoffUntil = Date.now() + 30_000;
    } finally {
      clearTimeout(tid);
    }
  }

  return map;
}

/**
 * Fetches USD prices for arbitrary Solana tokens by their mint addresses.
 * Used as a fallback for wallet tokens not covered by the ecosystem market map.
 * CoinGecko's /simple/token_price/solana needs no coin ID — just the mint.
 *
 * Response shape: { mintAddress: { usd, usd_24h_change, usd_market_cap, usd_24h_vol } }
 *
 * @param {string[]} mintAddresses
 * @returns {Promise<Record<string, { usd: number, usd_24h_change: number|null }>>}
 */
export async function fetchPricesByMint(mintAddresses) {
  if (!mintAddresses.length) return {};
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 6_000);
  try {
    const url =
      `https://api.coingecko.com/api/v3/simple/token_price/solana` +
      `?contract_addresses=${mintAddresses.join(',')}` +
      `&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`;
    const res = await fetch(url, { headers: cgHeaders(), signal: controller.signal });
    if (!res.ok) return {};
    return res.json();
  } catch {
    return {};
  } finally {
    clearTimeout(t);
  }
}
