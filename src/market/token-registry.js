// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — market/token-registry.js
// Resolves any Solana token to its mint address and decimal count.
//
// Resolution strategy:
//   1. Hardcoded core tokens (SOL, USDC) — always reliable, no network needed
//   2. In-memory cache — resolved tokens saved for 24h
//   3. CoinGecko /coins/{id} — fetches Solana mint + decimals on demand
//      using the coingeckoId from the ecosystem market data
//
// This avoids relying on Jupiter's token list (now requires auth) or the
// outdated Solana Labs token list (wrong addresses for newer tokens).
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const COINGECKO_COIN_URL = 'https://api.coingecko.com/api/v3/coins';
const CACHE_TTL      = 24 * 60 * 60 * 1000; // 24 hours — mint addresses are stable
const REGISTRY_FILE  = join(process.cwd(), 'data', 'token-registry-cache.json');

const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY ?? null;
function cgHeaders() {
  return COINGECKO_API_KEY ? { 'x-cg-demo-api-key': COINGECKO_API_KEY } : {};
}

function loadPersistedCache() {
  try {
    const raw = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
    // Re-hydrate as Map entries, skip stale entries
    return new Map(
      Object.entries(raw).filter(([, v]) => (Date.now() - v.resolvedAt) < CACHE_TTL)
    );
  } catch {
    return new Map();
  }
}

function persistCache(cache) {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(REGISTRY_FILE, JSON.stringify(Object.fromEntries(cache), null, 2));
  } catch { /* non-fatal */ }
}

// Hardcoded core tokens — always available, no fetch needed
const CORE_TOKENS = {
  SOL:  { mint: 'So11111111111111111111111111111111111111112',     decimals: 9  },
  USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6  },
  JUP:  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  decimals: 6  },
  BONK: { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5  },
  WIF:  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals: 6  },
  JTO:  { mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',  decimals: 9  },
  PYTH: { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', decimals: 6  },
  ORCA: { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',  decimals: 6  },
  RAY:  { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', decimals: 6  },
  POPCAT:   { mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', decimals: 9 },
  FARTCOIN: { mint: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump', decimals: 6 },
  AI16Z:    { mint: 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC', decimals: 6 },
  AIXBT:  { mint: '14zP2ToQ79XWvc7FQpm4bRnp9d6Mp1rFfsUW3gpLcRX',  decimals: 8 },
  POKT:   { mint: '6CAsXfiCXZfP8APCG6Vma2DFMindopxiqYQN4LSQfhoC',  decimals: 6 },
  GRASS:  { mint: 'Grass7B4RdKfBCjTKgSqnXkqjwiGvQyFbuSCUJr3XXjs',  decimals: 9 },
  SKR:    { mint: 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3',   decimals: 6 },
  PIPPIN: { mint: 'Dfh5DzRgSvvCFDoYc2ciTkMrbDfRKybA4SoFbPmApump',  decimals: 6 },
  '9BIT': { mint: 'HmMubgKx91Tpq3jmfcKQwsv5HrErqnCTTRJMB6afFR2u', decimals: 9 },
};

// Persistent cache: coingeckoId -> { mint, decimals, symbol, resolvedAt }
// Loaded from disk on startup so wallet tokens survive server restarts.
const _cache = loadPersistedCache();

// In-flight promises — prevents duplicate concurrent fetches for the same token
const _inflight = new Map();

/**
 * Resolves a token to its Solana mint address and decimal count.
 *
 * @param {string} symbol       - Token symbol (e.g. 'BONK')
 * @param {string} [coingeckoId] - CoinGecko coin ID (e.g. 'bonk') — required for dynamic lookup
 * @returns {Promise<{ mint: string, decimals: number } | null>}
 */
export async function resolveToken(symbol, coingeckoId) {
  const sym = symbol?.toUpperCase();

  // 1. Hardcoded core tokens
  if (CORE_TOKENS[sym]) return CORE_TOKENS[sym];

  // 2. In-memory cache (keyed by coingeckoId)
  if (coingeckoId) {
    const cached = _cache.get(coingeckoId);
    if (cached && (Date.now() - cached.resolvedAt) < CACHE_TTL) {
      return { mint: cached.mint, decimals: cached.decimals };
    }
  }

  if (!coingeckoId) return null;

  // 3. Fetch from CoinGecko — deduplicated per coingeckoId
  if (_inflight.has(coingeckoId)) return _inflight.get(coingeckoId);

  const promise = (async () => {
    try {
      const url = `${COINGECKO_COIN_URL}/${coingeckoId}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`;
      const res = await fetch(url, { headers: cgHeaders() });
      if (!res.ok) {
        console.warn(`[Mercer TokenRegistry] CoinGecko ${res.status} for ${coingeckoId}`);
        return null;
      }
      const data     = await res.json();
      const platform = data.detail_platforms?.solana;
      if (!platform?.contract_address) {
        console.warn(`[Mercer TokenRegistry] No Solana address for ${coingeckoId}`);
        return null;
      }
      const result = { mint: platform.contract_address, decimals: platform.decimal_place ?? 6 };
      _cache.set(coingeckoId, { ...result, symbol: sym, resolvedAt: Date.now() });
      persistCache(_cache);
      console.log(`[Mercer TokenRegistry] Resolved ${sym} (${coingeckoId}): ${result.mint}`);
      return result;
    } catch (err) {
      console.warn(`[Mercer TokenRegistry] Failed to resolve ${coingeckoId}: ${err.message}`);
      return null;
    } finally {
      _inflight.delete(coingeckoId);
    }
  })();

  _inflight.set(coingeckoId, promise);
  return promise;
}

/**
 * Reverse lookup — resolves a Solana mint address to token symbol and decimals.
 * Used by the wallet fetcher to identify tokens in the wallet.
 *
 * @param {string} mintAddress
 * @returns {{ symbol: string, decimals: number } | null}
 */
export function resolveMint(mintAddress) {
  for (const [symbol, info] of Object.entries(CORE_TOKENS)) {
    if (info.mint === mintAddress) return { symbol, decimals: info.decimals };
  }
  // Check dynamic cache (reverse lookup by mint — use stored symbol, not cgId)
  for (const [, info] of _cache.entries()) {
    if (info.mint === mintAddress) return { symbol: info.symbol ?? info.mint, decimals: info.decimals };
  }
  return null;
}

/**
 * Pre-resolves mint addresses for a list of tokens in the background.
 * Call this after fetching the ecosystem market list so addresses are
 * ready before Claude's first trade decision.
 *
 * @param {Array<{ symbol, coingeckoId }>} tokens
 */
export async function preResolveTokens(tokens) {
  const unknown = tokens.filter(t => !CORE_TOKENS[t.symbol?.toUpperCase()] && t.coingeckoId);
  if (unknown.length === 0) return;
  console.log(`[Mercer TokenRegistry] Pre-resolving ${unknown.length} token addresses...`);
  // Resolve in batches of 5 to avoid hammering CoinGecko
  for (let i = 0; i < unknown.length; i += 5) {
    const batch = unknown.slice(i, i + 5);
    await Promise.all(batch.map(t => resolveToken(t.symbol, t.coingeckoId)));
    if (i + 5 < unknown.length) await new Promise(r => setTimeout(r, 1500)); // rate limit friendly
  }
  console.log(`[Mercer TokenRegistry] Pre-resolution complete`);
}

/** No-op warm function kept for API compatibility */
export async function warmTokenRegistry() {
  // Token resolution is now lazy + on-demand — no bulk fetch needed
}
