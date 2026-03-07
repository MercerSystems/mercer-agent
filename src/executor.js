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
import { Connection, VersionedTransaction, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { sendAlert } from './notify.js';
import { resolveToken } from './market/token-registry.js';
import { signalTrade } from './trade-signal.js';

// ─── Debug: confirm env is loaded at module evaluation time ───────────────────
console.log('[Mercer Executor] WALLET_PRIVATE_KEY:', process.env.WALLET_PRIVATE_KEY
  ? 'KEY FOUND: ' + process.env.WALLET_PRIVATE_KEY.substring(0, 10) + '...'
  : 'KEY MISSING');

// ─── Timestamp helper ─────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

// ─── Safety flag ──────────────────────────────────────────────────────────────
const DRY_RUN = process.env.DRY_RUN !== 'false';

// USDC mint — always needed as the quote currency for all swaps
const USDC_MINT     = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;

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

  // Buying USDC is a no-op — sell proceeds already land in USDC automatically
  if (asset === 'USDC') {
    console.log(`[Mercer Executor] Hold USDC — sell proceeds already settled in USDC, no swap needed`);
    return { ...trade, status: 'skipped', reason: 'USDC proceeds already received from sells' };
  }

  // Resolve mint address dynamically via Jupiter token registry
  const coingeckoId = market[asset]?.coingeckoId;
  const tokenInfo   = await resolveToken(asset, coingeckoId);
  if (!tokenInfo) {
    const msg = `Cannot resolve mint for ${asset} (coingeckoId: ${coingeckoId ?? 'unknown'}) — not in Jupiter verified list`;
    console.error(`[Mercer Executor] ${msg}`);
    await sendAlert(`Warning: Trade skipped — ${msg}`);
    return { ...trade, status: 'blocked', reason: msg };
  }

  const { mint: assetMint, decimals: assetDecimals } = tokenInfo;

  // Convert USD trade size to raw token input amount
  let inputMint, outputMint, rawAmount;
  if (type === 'buy') {
    // Spend USDC to acquire the target asset
    inputMint  = USDC_MINT;
    outputMint = assetMint;
    rawAmount  = Math.round(amountUsd * Math.pow(10, USDC_DECIMALS));
  } else {
    // Sell the asset back to USDC
    const price = market[asset]?.price;
    if (!price) throw new Error(`No market price available for ${asset}`);
    inputMint  = assetMint;
    outputMint = USDC_MINT;
    rawAmount  = Math.round((amountUsd / price) * Math.pow(10, assetDecimals));
  }

  if (rawAmount <= 0) {
    throw new Error(`Calculated raw amount is 0 for ${type} ${asset} $${amountUsd} — trade too small`);
  }

  // ── MAX_TRADE_USD cap — trim to limit, never block entirely ───────────────
  const maxTradeUsd = parseFloat(process.env.MAX_TRADE_USD) || 35;
  if (amountUsd > maxTradeUsd) {
    console.log(`[Mercer Executor] Trade trimmed — $${amountUsd} → $${maxTradeUsd} (MAX_TRADE_USD cap)`);
    amountUsd = maxTradeUsd;
    // Recalculate rawAmount with the trimmed value
    if (type === 'buy') {
      rawAmount = Math.round(amountUsd * Math.pow(10, USDC_DECIMALS));
    } else {
      const price = market[asset]?.price;
      if (price) rawAmount = Math.round((amountUsd / price) * Math.pow(10, assetDecimals));
    }
  }

  // ── Get quote ──────────────────────────────────────────────────────────────
  const quoteParams = { inputMint, outputMint, amount: rawAmount, slippageBps: 50 };
  const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${rawAmount}&slippageBps=50`;

  console.log(`[Mercer Executor] ${ts()} — Quote request — ${type.toUpperCase()} ${asset}`);
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
    `[Mercer Executor] ${ts()} — Quote — ${type.toUpperCase()} ${asset}` +
    ` | in: ${quote.inAmount} | out: ${quote.outAmount}` +
    ` | price impact: ${quote.priceImpactPct}%`
  );

  // ── Price impact guard ─────────────────────────────────────────────────────
  const maxImpact   = parseFloat(process.env.MAX_PRICE_IMPACT_PCT) || 2.0;
  const priceImpact = parseFloat(quote.priceImpactPct ?? 0);
  if (priceImpact > maxImpact) {
    const msg = `Price impact ${priceImpact.toFixed(2)}% exceeds ${maxImpact}% limit for ${type.toUpperCase()} ${asset} $${amountUsd} — trade blocked`;
    console.warn(`[Mercer Executor] BLOCKED — ${msg}`);
    await sendAlert(`Warning: ${msg}`);
    return { ...trade, status: 'blocked', reason: msg };
  }

  if (DRY_RUN) {
    console.log(`[Mercer Executor] ${ts()} — DRY_RUN=true — skipping broadcast for ${type} ${asset} $${amountUsd}`);
    return { ...trade, status: 'dry_run', quote };
  }

  // ── Pre-flight balance checks ──────────────────────────────────────────────
  if (!process.env.SOLANA_RPC_URL) {
    throw new Error('SOLANA_RPC_URL not set in .env — required for live execution.');
  }
  {
    const minSolForGas = parseFloat(process.env.MIN_SOL_FOR_GAS) || 0.01;
    const keypair      = loadKeypair();
    const connection   = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');

    // SOL gas check
    const lamports   = await connection.getBalance(keypair.publicKey);
    const solBalance = lamports / 1e9;
    if (solBalance < minSolForGas) {
      const msg = `Insufficient SOL for gas: ${solBalance.toFixed(4)} SOL < ${minSolForGas} minimum — trade blocked`;
      console.error(`[Mercer Executor] ${msg}`);
      await sendAlert(`Warning: ${msg}`);
      return { ...trade, status: 'blocked', reason: msg };
    }

    // USDC balance check for buys — prevents failed on-chain txs when Claude
    // proposes a buy larger than available cash
    if (type === 'buy') {
      const { value: usdcAccounts } = await connection.getParsedTokenAccountsByOwner(
        keypair.publicKey,
        { mint: new PublicKey(USDC_MINT) }
      );
      const usdcBalance = usdcAccounts[0]?.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
      if (usdcBalance < amountUsd) {
        const msg = `Insufficient USDC: $${usdcBalance.toFixed(2)} available < $${amountUsd} required — buy blocked`;
        console.error(`[Mercer Executor] ${msg}`);
        await sendAlert(`Warning: ${msg}`);
        return { ...trade, status: 'blocked', reason: msg };
      }
    }
  }

  // ── Build swap transaction ─────────────────────────────────────────────────
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

    console.log(`[Mercer Executor] ${ts()} — Confirmed — ${type.toUpperCase()} ${asset} | tx: https://solscan.io/tx/${txid}`);
    signalTrade();
    return { ...trade, status: 'executed', txid };

  } catch (err) {
    console.error(`[Mercer Executor] Execution failed for ${type} ${asset}:`, err.message);
    await sendAlert(`Warning: Execution FAILED — ${type.toUpperCase()} ${asset} $${amountUsd} — ${err.message}`);
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
