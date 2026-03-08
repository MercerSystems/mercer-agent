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
const MIN_VOL_1H       =       500;  // $500 1h volume — low bar to catch early movers
const MIN_BUY_SELL_5M  =      0.40;  // buys / (buys+sells) in 5m — more buys than sells
const MAX_AGE_HOURS    =        72;  // max 72h old — give 3-day window for fresh launches
const MAX_PRICE_DROP_1H=       -40;  // don't enter tokens dumping >40% in 1h

// DEXes we can trade on — either via Jupiter (graduated) or pump.fun bonding curve (pre-graduation)
const JUPITER_DEXES  = new Set(['raydium', 'raydium-clmm', 'raydium-cpmm', 'orca', 'whirlpool', 'meteora', 'meteora-dlmm', 'lifinity-v2', 'openbook-v2']);
const PUMPFUN_DEXES  = new Set(['pump-fun', 'pumpfun', 'pumpswap']); // pumpswap = graduated pump.fun tokens on new PumpSwap DEX

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

function normalize(pair, profile = null) {
  const ageMs    = Date.now() - (pair.pairCreatedAt ?? 0);
  const ageHours = ageMs / 3_600_000;
  const sym      = pair.baseToken.symbol?.toUpperCase();
  const txns5m   = pair.txns?.m5;
  const total5m  = (txns5m?.buys ?? 0) + (txns5m?.sells ?? 0);
  const bsRatio  = total5m > 0 ? (txns5m.buys / total5m) : 0.5;

  // Social presence from token profile
  const links       = profile?.links ?? [];
  const hasTwitter  = links.some(l => l.type === 'twitter'  || l.url?.includes('twitter') || l.url?.includes('x.com'));
  const hasTelegram = links.some(l => l.type === 'telegram' || l.url?.includes('t.me'));
  const hasWebsite  = links.some(l => l.type === 'website'  || (!l.url?.includes('twitter') && !l.url?.includes('t.me') && l.url?.startsWith('http')));
  const socialScore = (hasTwitter ? 1 : 0) + (hasTelegram ? 1 : 0) + (hasWebsite ? 1 : 0);
  const description = profile?.description
    ? profile.description.replace(/\s+/g, ' ').trim().slice(0, 120)
    : null;

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
    hasTwitter,
    hasTelegram,
    hasWebsite,
    socialScore,   // 0–3: number of social channels present
    description,   // short project description from DexScreener profile
    _dexscreener:  true,
    _pumpfun:      PUMPFUN_DEXES.has(pair.dexId),
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

// ─── DexScreener boosted tokens ───────────────────────────────────────────────
// Tokens with active boosts are being actively promoted — team/community is
// spending real money on visibility. Combined with pair data this gives us
// fresh pump.fun coins with social context and real price/volume data.
const BOOSTS_URL = 'https://api.dexscreener.com/token-boosts/latest/v1';

async function fetchBoostedCoins() {
  try {
    const boosts = await fetchJson(BOOSTS_URL);
    if (!Array.isArray(boosts)) return { mints: [], profileData: new Map() };

    const profileData = new Map();
    const mints = [];

    for (const b of boosts) {
      if (b.chainId !== 'solana') continue;
      const mint = b.tokenAddress;
      if (!mint) continue;
      mints.push(mint);
      profileData.set(mint, {
        description: b.description ?? null,
        links:       b.links       ?? [],
        boostAmount: b.totalAmount ?? 0,
      });
    }

    return { mints: [...new Set(mints)], profileData };
  } catch (err) {
    console.warn(`[Mercer DexScreener] Boosts fetch failed: ${err.message}`);
    return { mints: [], profileData: new Map() };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetches new Solana token launches from two sources:
 *   1. pump.fun API — pre-graduation bonding curve coins (primary source)
 *   2. DexScreener profiles — graduated tokens with DEX pairs
 * Results cached for 60s.
 *
 * @returns {Promise<Record<string, object>>} Market map entries keyed by symbol
 */
export async function fetchNewLaunches() {
  if (_cache && (Date.now() - _cacheTime) < CACHE_TTL_MS) return _cache;

  const result      = {};
  const seenSymbols = new Set(['SOL', 'USDC']);

  // ── Helper: batch-fetch pair data and normalize ───────────────────────────
  async function processMints(mints, profileData) {
    const BATCH    = 30;
    const allPairs = [];
    for (let i = 0; i < mints.length; i += BATCH) {
      try {
        const data = await fetchJson(TOKENS_URL + mints.slice(i, i + BATCH).join(','));
        allPairs.push(...(data.pairs ?? []));
      } catch (err) {
        console.warn(`[Mercer DexScreener] Batch fetch failed: ${err.message}`);
      }
    }
    const byMint = new Map();
    for (const pair of allPairs) {
      if (pair.chainId !== 'solana' || !pair.priceUsd) continue;
      const mint = pair.baseToken?.address;
      if (!mint) continue;
      const existing = byMint.get(mint);
      if (!existing || (pair.volume?.h24 ?? 0) > (existing.volume?.h24 ?? 0)) byMint.set(mint, pair);
    }
    let count = 0;
    for (const pair of byMint.values()) {
      const profile = profileData?.get(pair.baseToken?.address) ?? null;
      const entry   = normalize(pair, profile);
      if (!entry.symbol || seenSymbols.has(entry.symbol)) continue;
      if (!meetsQuality(entry)) continue;
      seenSymbols.add(entry.symbol);
      result[entry.symbol] = entry;
      registerMint(entry.symbol, entry.mint, 6);
      count++;
    }
    return count;
  }

  // ── Source 1: DexScreener boosted tokens (active promotion = real interest)
  try {
    const { mints: boostMints, profileData: boostProfiles } = await fetchBoostedCoins();
    if (boostMints.length > 0) {
      const n = await processMints(boostMints, boostProfiles);
      console.log(`[Mercer DexScreener] ${n} boosted launches (${boostMints.length} boosts scanned)`);
    }
  } catch (err) {
    console.warn(`[Mercer DexScreener] Boosts source failed: ${err.message}`);
  }

  // ── Source 2: DexScreener profiles (broader coverage) ────────────────────
  try {
    const profiles    = await fetchJson(PROFILES_URL);
    const profileData = new Map();
    const solanaMints = profiles
      .filter(p => p.chainId === 'solana')
      .map(p => {
        profileData.set(p.tokenAddress, { description: p.description ?? null, links: p.links ?? [] });
        return p.tokenAddress;
      })
      .slice(0, 100);
    if (solanaMints.length > 0) {
      const n = await processMints(solanaMints, profileData);
      console.log(`[Mercer DexScreener] ${n} profile launches (${solanaMints.length} profiles scanned)`);
    }
  } catch (err) {
    console.warn(`[Mercer DexScreener] Profiles source failed: ${err.message}`);
  }

  console.log(`[Mercer] New launches total: ${Object.keys(result).length}`);
  _cache     = result;
  _cacheTime = Date.now();
  return result;
}
