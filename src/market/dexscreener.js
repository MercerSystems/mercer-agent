// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — market/dexscreener.js
// New token discovery via DexScreener API (free, no key needed).
//
// Fetches recently launched Solana tokens with momentum — covers the sub-$1M
// cap space that CoinGecko's ecosystem list completely misses.
//
// Flow:
//   1. /token-profiles/latest/v1  — most recently listed Solana tokens (~50)
//   2. /latest/dex/tokens/{mints} — batch-fetch price/volume/age data per token
//   3. Filter + normalize → market map entries compatible with solana-market.js
//   4. Register mints in token-registry so executor can resolve them without CoinGecko
// ─────────────────────────────────────────────────────────────────────────────

import { registerMint } from './token-registry.js';

const PROFILES_URL = 'https://api.dexscreener.com/token-profiles/latest/v1';
const TOKENS_URL   = 'https://api.dexscreener.com/latest/dex/tokens/';
const CACHE_TTL_MS = 60_000; // 60s — DexScreener rate limits: 300 req/min

let _cache     = null;
let _cacheTime = 0;

// ─── Filters ──────────────────────────────────────────────────────────────────
const MIN_MARKET_CAP   =     5_000;  // $5K — must have some traction
const MAX_MARKET_CAP   = 2_000_000;  // $2M — small enough for asymmetric return
const MIN_VOL_1H       =     2_000;  // $2K volume in last hour — actively trading
const MIN_BUY_SELL_5M  =       0.5;  // buys / (buys+sells) in 5m — majority buying, not dumping
const MAX_AGE_HOURS    =        48;  // max 48h old — fresh launches only
const MAX_PRICE_DROP_1H=       -40;  // don't enter tokens dumping >40% in 1h

// DEXes we can trade on — either via Jupiter (graduated) or pump.fun bonding curve (pre-graduation)
const JUPITER_DEXES  = new Set(['raydium', 'raydium-clmm', 'raydium-cpmm', 'orca', 'whirlpool', 'meteora', 'meteora-dlmm', 'lifinity-v2', 'openbook-v2']);
const PUMPFUN_DEXES  = new Set(['pump-fun']);

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`DexScreener ${res.status} — ${url}`);
  return res.json();
}

function bestPair(pairs) {
  // Pick the pair with the highest 24h volume for a given token
  return pairs
    .filter(p => p.chainId === 'solana' && p.priceUsd)
    .sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))[0] ?? null;
}

function normalize(pair) {
  const ageMs    = Date.now() - (pair.pairCreatedAt ?? 0);
  const ageHours = ageMs / 3_600_000;
  const sym      = pair.baseToken.symbol?.toUpperCase();
  const txns5m   = pair.txns?.m5;
  const total5m  = (txns5m?.buys ?? 0) + (txns5m?.sells ?? 0);
  const bsRatio  = total5m > 0 ? (txns5m.buys / total5m) : 0.5;

  return {
    price:         parseFloat(pair.priceUsd ?? 0),
    change1h:      pair.priceChange?.h1  ?? null,
    change24h:     pair.priceChange?.h24 ?? null,
    changeM5:      pair.priceChange?.m5  ?? null,
    volume24hUsd:  pair.volume?.h24 ?? 0,
    volume1hUsd:   pair.volume?.h1  ?? 0,
    marketCapUsd:  pair.marketCap   ?? pair.fdv ?? 0,
    mint:          pair.baseToken.address,
    symbol:        sym,
    ageHours:      parseFloat(ageHours.toFixed(1)),
    dex:           pair.dexId,
    pairAddress:   pair.pairAddress,
    buySellRatio:  parseFloat(bsRatio.toFixed(2)),
    _dexscreener:  true,
    _pumpfun:      pair.dexId === 'pump-fun',
  };
}

function meetsQuality(entry) {
  if (!entry.price || entry.price <= 0)                                       return false;
  if (!JUPITER_DEXES.has(entry.dex) && !PUMPFUN_DEXES.has(entry.dex))        return false;
  if (entry.marketCapUsd < MIN_MARKET_CAP)            return false;
  if (entry.marketCapUsd > MAX_MARKET_CAP)            return false;
  if (entry.volume1hUsd < MIN_VOL_1H)                 return false;
  if (entry.ageHours > MAX_AGE_HOURS)                 return false;
  if ((entry.change1h ?? 0) < MAX_PRICE_DROP_1H)      return false;
  if (entry.buySellRatio < MIN_BUY_SELL_5M)           return false;
  return true;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetches and returns new Solana token launches with momentum.
 * Results are cached for 60s to avoid hammering DexScreener.
 *
 * @returns {Promise<Record<string, object>>} Market map entries keyed by symbol
 */
export async function fetchNewLaunches() {
  if (_cache && (Date.now() - _cacheTime) < CACHE_TTL_MS) return _cache;

  try {
    // 1. Get latest token profiles
    const profiles = await fetchJson(PROFILES_URL);
    const solanaMints = profiles
      .filter(p => p.chainId === 'solana')
      .map(p => p.tokenAddress)
      .slice(0, 60); // take latest 60

    if (solanaMints.length === 0) { _cache = {}; _cacheTime = Date.now(); return {}; }

    // 2. Batch-fetch pair data (max 30 mints per request)
    const BATCH = 30;
    const allPairs = [];
    for (let i = 0; i < solanaMints.length; i += BATCH) {
      const batch = solanaMints.slice(i, i + BATCH);
      try {
        const data = await fetchJson(TOKENS_URL + batch.join(','));
        allPairs.push(...(data.pairs ?? []));
      } catch (err) {
        console.warn(`[Mercer DexScreener] Batch fetch failed: ${err.message}`);
      }
    }

    // 3. Group by base token, pick best pair per token
    const byMint = new Map();
    for (const pair of allPairs) {
      if (pair.chainId !== 'solana' || !pair.priceUsd) continue;
      const mint = pair.baseToken?.address;
      if (!mint) continue;
      const existing = byMint.get(mint);
      if (!existing || (pair.volume?.h24 ?? 0) > (existing.volume?.h24 ?? 0)) {
        byMint.set(mint, pair);
      }
    }

    // 4. Normalize, filter, deduplicate by symbol
    const result = {};
    const seenSymbols = new Set(['SOL', 'USDC']); // never override core tokens

    for (const pair of byMint.values()) {
      const entry = normalize(pair);
      if (!entry.symbol || seenSymbols.has(entry.symbol)) continue;
      if (!meetsQuality(entry)) continue;

      seenSymbols.add(entry.symbol);
      result[entry.symbol] = entry;

      // 5. Register mint so executor can trade without CoinGecko lookup
      registerMint(entry.symbol, entry.mint, 6); // most pump.fun tokens = 6 decimals
    }

    console.log(`[Mercer DexScreener] ${Object.keys(result).length} new launches discovered (${solanaMints.length} profiles scanned)`);
    _cache = result;
    _cacheTime = Date.now();
    return result;

  } catch (err) {
    console.warn(`[Mercer DexScreener] Fetch failed: ${err.message}`);
    return _cache ?? {};
  }
}
