// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — swap/jupiter.js
// Jupiter swap execution: quote + transaction building
// Set SIMULATE=true to log quotes without broadcasting to the network.
// ─────────────────────────────────────────────────────────────────────────────

import { Connection, VersionedTransaction, Keypair } from '@solana/web3.js';

// ─── Safety flag ──────────────────────────────────────────────────────────────
// When true: fetch and log quotes but never broadcast transactions.
// Set to false (or MERCER_SIMULATE=false in .env) to enable live execution.
const SIMULATE = process.env.MERCER_SIMULATE !== 'false';

const QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const SWAP_API  = 'https://quote-api.jup.ag/v6/swap';

// Supported mints (expand as needed)
export const MINTS = {
  SOL:  'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

// Token decimals for human-readable → raw amount conversion
export const DECIMALS = {
  SOL:  9,
  USDC: 6,
};

/**
 * Converts a human-readable token amount to its raw integer representation.
 * e.g. toRawAmount(10, 9) → 10_000_000_000 (10 SOL in lamports)
 *
 * @param {number} amount   - Human-readable amount (e.g. 10)
 * @param {number} decimals - Token decimal places
 * @returns {string} Raw integer amount as string (avoids JS float precision issues)
 */
export function toRawAmount(amount, decimals) {
  return Math.round(amount * Math.pow(10, decimals)).toString();
}

/**
 * Fetches a swap quote from the Jupiter Quote API.
 *
 * @param {string} inputMint  - Input token mint address
 * @param {string} outputMint - Output token mint address
 * @param {string} amount     - Raw input amount (smallest unit, as string)
 * @param {number} [slippageBps=50] - Slippage tolerance in basis points (50 = 0.5%)
 * @returns {Promise<object>} Jupiter quote response
 */
export async function getSwapQuote(inputMint, outputMint, amount, slippageBps = 50) {
  const url =
    `${QUOTE_API}` +
    `?inputMint=${inputMint}` +
    `&outputMint=${outputMint}` +
    `&amount=${amount}` +
    `&slippageBps=${slippageBps}`;

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`Jupiter Quote API network error fetching ${url} — ${err.message}`);
  }

  if (!res.ok) {
    throw new Error(`Jupiter Quote API ${res.status} ${res.statusText} fetching ${url}`);
  }

  return res.json();
}

/**
 * Builds and (if SIMULATE=false) broadcasts a Jupiter swap transaction.
 *
 * When SIMULATE=true (default): logs the quote and returns without touching
 * the network. Safe to call at any time during development.
 *
 * When SIMULATE=false: fetches the serialized transaction from Jupiter,
 * signs it with the WALLET_PRIVATE_KEY from .env (JSON byte-array format),
 * and broadcasts via SOLANA_RPC_URL.
 *
 * @param {object} quoteResponse  - Quote object returned by getSwapQuote()
 * @param {string} userPublicKey  - Base58 wallet public key
 * @returns {Promise<{ simulated: boolean, quote?: object, txid?: string }>}
 */
export async function executeSwap(quoteResponse, userPublicKey) {
  if (SIMULATE) {
    console.log('[Mercer Swap] SIMULATE=true — transaction not broadcast.');
    console.log('[Mercer Swap] Input:  ', quoteResponse.inputMint, quoteResponse.inAmount);
    console.log('[Mercer Swap] Output: ', quoteResponse.outputMint, quoteResponse.outAmount);
    console.log('[Mercer Swap] Price impact:', quoteResponse.priceImpactPct, '%');
    return { simulated: true, quote: quoteResponse };
  }

  // ── Build transaction ────────────────────────────────────────────────────────
  let swapRes;
  try {
    swapRes = await fetch(SWAP_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: true,
      }),
    });
  } catch (err) {
    throw new Error(`Jupiter Swap API network error — ${err.message}`);
  }

  if (!swapRes.ok) {
    throw new Error(`Jupiter Swap API ${swapRes.status} ${swapRes.statusText}`);
  }

  const { swapTransaction } = await swapRes.json();

  // ── Sign and broadcast ───────────────────────────────────────────────────────
  if (!process.env.WALLET_PRIVATE_KEY) {
    throw new Error('WALLET_PRIVATE_KEY not set in .env — required for live swap execution.');
  }
  if (!process.env.SOLANA_RPC_URL) {
    throw new Error('SOLANA_RPC_URL not set in .env — required for live swap execution.');
  }

  // WALLET_PRIVATE_KEY must be a JSON byte-array, e.g. [12,34,56,...]
  // Export from Phantom: Settings → Security → Export private key → use solana-keygen
  const secretKey = Uint8Array.from(JSON.parse(process.env.WALLET_PRIVATE_KEY));
  const keypair   = Keypair.fromSecretKey(secretKey);

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([keypair]);

  const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
  const txid = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection.confirmTransaction(txid, 'confirmed');

  console.log(`[Mercer Swap] Confirmed: https://solscan.io/tx/${txid}`);
  return { simulated: false, txid };
}
