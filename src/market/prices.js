// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — market/prices.js
// Jupiter Price API v6 — real-time Solana token prices priced in USDC
// Docs: https://station.jup.ag/docs/apis/price-api
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = 'https://price.jup.ag/v6/price';
const CACHE_TTL_MS = 60_000;

// Jupiter identifies tokens by their on-chain mint address
const MINTS = {
  SOL:  'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  JUP:  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF:  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  JTO:  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  PYTH: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
};

// In-memory cache keyed by sorted symbol list, e.g. "BONK,JUP,SOL,USDC,WIF"
const cache = new Map();

/**
 * Fetches live market data for the requested token symbols from Jupiter Price API.
 * Results are cached for 60 seconds per unique set of symbols.
 *
 * @param {string[]} symbols - Token symbols (must be in MINTS)
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

  const mints = symbols.map((s) => {
    const mint = MINTS[s];
    if (!mint) throw new Error(`No mint address mapping for token: ${s}`);
    return mint;
  });

  const url = `${BASE_URL}?ids=${mints.join(',')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jupiter Price API ${res.status}: ${res.statusText}`);

  const json = await res.json();

  const market = {};
  for (const symbol of symbols) {
    const mint  = MINTS[symbol];
    const entry = json.data?.[mint];
    if (!entry) throw new Error(`Jupiter returned no price for ${symbol} (mint: ${mint})`);

    market[symbol] = {
      price:        entry.price,
      change24h:    null,  // not provided by Jupiter Price API v6
      volume24hUsd: null,
      marketCapUsd: null,
    };
  }

  cache.set(cacheKey, { data: market, expiresAt: Date.now() + CACHE_TTL_MS });
  return market;
}
