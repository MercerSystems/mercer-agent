// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — executor.js
// Jupiter swap execution layer
//
// DRY_RUN=true  (default) — quotes are fetched and logged, no transaction sent
// DRY_RUN=false           — live execution: signs and broadcasts to Solana mainnet
//
// WALLET_PRIVATE_KEY accepts two formats:
//   JSON byte-array: [12,34,56,...]   — Solana CLI: cat ~/.config/solana/id.json
//   Base58 string:   5Kb8kLf9...      — Phantom/Backpack: Settings → Export private key
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import { createJupiterApiClient } from '@jup-ag/api';
import { Connection, VersionedTransaction, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// ─── Debug: confirm env is loaded at module evaluation time ───────────────────
console.log('[Mercer Executor] WALLET_PRIVATE_KEY:', process.env.WALLET_PRIVATE_KEY
  ? 'KEY FOUND: ' + process.env.WALLET_PRIVATE_KEY.substring(0, 10) + '...'
  : 'KEY MISSING');

// ─── Safety flag ──────────────────────────────────────────────────────────────
const DRY_RUN = process.env.DRY_RUN !== 'false';

// ─── Token registry ───────────────────────────────────────────────────────────
const MINTS = {
  SOL:  'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  JUP:  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF:  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
};

const DECIMALS = {
  SOL:  9,
  USDC: 6,
  JUP:  6,
  BONK: 5,
  WIF:  6,
};

// Actions that produce trades worth executing
const EXECUTABLE_ACTIONS = new Set(['rebalance', 'adjust', 'buy', 'sell']);

// ─── Keypair loader ───────────────────────────────────────────────────────────
function loadKeypair() {
  const raw = process.env.WALLET_PRIVATE_KEY;
  if (!raw) {
    throw new Error('WALLET_PRIVATE_KEY not set in .env — required for live execution.');
  }

  // JSON byte-array: [12,34,56,...]
  if (raw.trimStart().startsWith('[')) {
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    } catch {
      throw new Error('WALLET_PRIVATE_KEY looks like a JSON byte-array but failed to parse — ensure it is a valid array of integers, e.g. [12,34,56,...]');
    }
  }

  // Base58 string (Phantom / Backpack export)
  try {
    return Keypair.fromSecretKey(bs58.decode(raw.trim()));
  } catch {
    throw new Error('WALLET_PRIVATE_KEY could not be decoded — expected a JSON byte-array [12,34,...] or a base58 string');
  }
}

// ─── Single trade executor ────────────────────────────────────────────────────
async function executeTrade(trade, market, jupiterApi) {
  const { type, asset, amountUsd } = trade;

  const assetMint = MINTS[asset];
  if (!assetMint) {
    throw new Error(`No mint address registered for asset: ${asset}`);
  }

  // Buying or selling USDC-for-USDC is a no-op — skip it
  if (asset === 'USDC') {
    console.log(`[Mercer Executor] Skipping ${type} USDC — USDC is the quote currency, not a swap target`);
    return { ...trade, status: 'skipped', reason: 'USDC is the quote currency' };
  }

  // Convert USD trade size to raw token input amount
  let inputMint, outputMint, rawAmount;
  if (type === 'buy') {
    // Spend USDC to acquire the target asset
    inputMint  = MINTS.USDC;
    outputMint = assetMint;
    rawAmount  = Math.round(amountUsd * Math.pow(10, DECIMALS.USDC));
  } else {
    // Sell the asset back to USDC
    const price = market[asset]?.price;
    if (!price) throw new Error(`No market price available for ${asset}`);
    inputMint  = assetMint;
    outputMint = MINTS.USDC;
    rawAmount  = Math.round((amountUsd / price) * Math.pow(10, DECIMALS[asset]));
  }

  if (rawAmount <= 0) {
    throw new Error(`Calculated raw amount is 0 for ${type} ${asset} $${amountUsd} — trade too small`);
  }

  // ── MAX_TRADE_USD cap ──────────────────────────────────────────────────────
  const maxTradeUsd = parseFloat(process.env.MAX_TRADE_USD) || 50;
  if (amountUsd > maxTradeUsd) {
    console.log(`[Mercer Executor] Trade blocked — $${amountUsd} exceeds MAX_TRADE_USD limit of $${maxTradeUsd}`);
    return { ...trade, status: 'blocked', reason: `exceeds MAX_TRADE_USD limit of $${maxTradeUsd}` };
  }

  // ── Get quote ──────────────────────────────────────────────────────────────
  const quoteParams = { inputMint, outputMint, amount: rawAmount, slippageBps: 50 };
  const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${rawAmount}&slippageBps=50`;

  console.log(`[Mercer Executor] Quote request — ${type.toUpperCase()} ${asset}`);
  console.log(`[Mercer Executor]   URL:         ${quoteUrl}`);
  console.log(`[Mercer Executor]   inputMint:   ${inputMint}`);
  console.log(`[Mercer Executor]   outputMint:  ${outputMint}`);
  console.log(`[Mercer Executor]   amount:      ${rawAmount} (raw) = $${amountUsd} USD`);
  console.log(`[Mercer Executor]   slippageBps: 50`);

  let quote;
  try {
    quote = await jupiterApi.quoteGet(quoteParams);
  } catch (err) {
    // @jup-ag/api wraps HTTP errors — try to extract the full response body
    let body = '';
    try {
      body = err.response ? await err.response.text() : '';
    } catch {
      body = '(could not read response body)';
    }
    console.error(`[Mercer Executor] Quote FAILED for ${type.toUpperCase()} ${asset}`);
    console.error(`[Mercer Executor]   error:    ${err.message}`);
    console.error(`[Mercer Executor]   status:   ${err.response?.status ?? 'n/a'}`);
    console.error(`[Mercer Executor]   body:     ${body}`);
    throw new Error(`Jupiter quote failed for ${type} ${asset}: ${err.message} — ${body}`);
  }

  console.log(
    `[Mercer Executor] Quote — ${type.toUpperCase()} ${asset}` +
    ` | in: ${quote.inAmount} | out: ${quote.outAmount}` +
    ` | price impact: ${quote.priceImpactPct}%`
  );

  if (DRY_RUN) {
    console.log(`[Mercer Executor] DRY_RUN=true — skipping broadcast for ${type} ${asset} $${amountUsd}`);
    return { ...trade, status: 'dry_run', quote };
  }

  // ── Build swap transaction ─────────────────────────────────────────────────
  if (!process.env.SOLANA_RPC_URL) {
    throw new Error('SOLANA_RPC_URL not set in .env — required for live execution.');
  }

  let swapResult;
  try {
    const keypair = loadKeypair();
    swapResult = await jupiterApi.swapPost({
      swapRequest: {
        quoteResponse:    quote,
        userPublicKey:    keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      },
    });

    // ── Sign and broadcast ───────────────────────────────────────────────────
    const tx = VersionedTransaction.deserialize(
      Buffer.from(swapResult.swapTransaction, 'base64')
    );
    tx.sign([keypair]);

    const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
    const txid = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries:    3,
    });
    await connection.confirmTransaction(txid, 'confirmed');

    console.log(`[Mercer Executor] Confirmed — ${type.toUpperCase()} ${asset} | tx: https://solscan.io/tx/${txid}`);
    return { ...trade, status: 'executed', txid };

  } catch (err) {
    console.error(`[Mercer Executor] Execution failed for ${type} ${asset}:`, err.message);
    return { ...trade, status: 'failed', error: err.message };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Attempts to execute any trades in a Claude decision via Jupiter swaps.
 * Returns null if the decision has no executable action or no trades.
 *
 * @param {object} decision  - Validated decision from the reasoning loop
 * @param {object} market    - Current market snapshot (for price → token amount conversion)
 * @returns {Promise<{
 *   status: 'dry_run' | 'executed' | 'skipped',
 *   trades: object[]
 * } | null>}
 */
export async function executeDecision(decision, market) {
  if (!EXECUTABLE_ACTIONS.has(decision.action)) {
    return { status: 'skipped', reason: `action '${decision.action}' does not require execution` };
  }

  if (!decision.trades?.length) {
    return { status: 'skipped', reason: 'no trades in decision' };
  }

  const jupiterApi = createJupiterApiClient();
  const tradeResults = [];

  for (const trade of decision.trades) {
    const result = await executeTrade(trade, market, jupiterApi);
    tradeResults.push(result);
  }

  const anyExecuted = tradeResults.some(t => t.status === 'executed');
  const anyFailed   = tradeResults.some(t => t.status === 'failed');

  return {
    status: DRY_RUN        ? 'dry_run'
          : anyFailed      ? 'partial'
          : anyExecuted    ? 'executed'
          : 'skipped',
    dryRun: DRY_RUN,
    trades: tradeResults,
  };
}
