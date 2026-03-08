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
import { addToBlockedBuys } from './agent/blocked-buys.js';
import { pumpFunBuy, pumpFunSell, isOnBondingCurve } from './pumpfun.js';
import { recordPumpBuy, removePumpPosition } from './pump-monitor.js';

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

// ─── Token-to-token swap executor ─────────────────────────────────────────────
async function executeSwapTrade(trade, market, jupiterApi) {
  const { fromAsset, toAsset } = trade;
  let amountUsd = trade.amountUsd;

  // Resolve from-asset mint
  const fromCoingeckoId = market[fromAsset]?.coingeckoId;
  const fromTokenInfo   = await resolveToken(fromAsset, fromCoingeckoId);
  if (!fromTokenInfo) {
    const msg = `Cannot resolve mint for ${fromAsset} (coingeckoId: ${fromCoingeckoId ?? 'unknown'}) — swap blocked`;
    console.error(`[Mercer Executor] ${msg}`);
    await sendAlert(`Warning: Swap skipped — ${msg}`);
    return { ...trade, status: 'blocked', reason: msg };
  }

  // Resolve to-asset mint
  const toCoingeckoId = market[toAsset]?.coingeckoId;
  const toTokenInfo   = await resolveToken(toAsset, toCoingeckoId);
  if (!toTokenInfo) {
    const msg = `Cannot resolve mint for ${toAsset} (coingeckoId: ${toCoingeckoId ?? 'unknown'}) — swap blocked`;
    console.error(`[Mercer Executor] ${msg}`);
    await sendAlert(`Warning: Swap skipped — ${msg}`);
    return { ...trade, status: 'blocked', reason: msg };
  }

  const fromPrice = market[fromAsset]?.price;
  if (!fromPrice) throw new Error(`No market price available for ${fromAsset}`);

  const inputMint  = fromTokenInfo.mint;
  const outputMint = toTokenInfo.mint;
  let rawAmount    = Math.round((amountUsd / fromPrice) * Math.pow(10, fromTokenInfo.decimals));

  if (rawAmount <= 0) {
    throw new Error(`Calculated raw amount is 0 for swap ${fromAsset} → ${toAsset} $${amountUsd} — trade too small`);
  }

  // ── MIN_TRADE_USD floor ────────────────────────────────────────────────────
  const minTradeUsd = parseFloat(process.env.MIN_TRADE_USD) || 3;
  if (amountUsd < minTradeUsd) {
    const msg = `Swap too small: $${amountUsd.toFixed(2)} below $${minTradeUsd} minimum — skipped to avoid wasting gas`;
    console.log(`[Mercer Executor] ${msg}`);
    return { ...trade, status: 'skipped', reason: msg };
  }

  // ── MAX_TRADE_USD cap ──────────────────────────────────────────────────────
  const maxTradeUsd = parseFloat(process.env.MAX_TRADE_USD) || 35;
  if (amountUsd > maxTradeUsd) {
    console.log(`[Mercer Executor] Swap trimmed — $${amountUsd} → $${maxTradeUsd} (MAX_TRADE_USD cap)`);
    amountUsd = maxTradeUsd;
    rawAmount = Math.round((amountUsd / fromPrice) * Math.pow(10, fromTokenInfo.decimals));
  }

  // ── Full-exit snap — use exact on-chain balance when swapping ≥90% of position ─
  // Prevents EAT/other micro-cap dust from price-rounding on token-to-token swaps.
  if (!DRY_RUN && process.env.SOLANA_RPC_URL) {
    try {
      const kp   = loadKeypair();
      const conn = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
      const { value: tokenAccounts } = await conn.getParsedTokenAccountsByOwner(
        kp.publicKey, { mint: new PublicKey(inputMint) }
      );
      const onChainRaw    = tokenAccounts[0]?.account.data.parsed.info.tokenAmount.amount   ?? '0';
      const onChainUi     = tokenAccounts[0]?.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
      const onChainRawInt = Number(onChainRaw);
      if (onChainRawInt > 0 && rawAmount >= Math.floor(onChainRawInt * 0.90)) {
        console.log(`[Mercer Executor] ${ts()} — Full-exit snap: swapping entire ${fromAsset} balance (${onChainUi}) to avoid dust`);
        rawAmount = onChainRawInt;
      }
    } catch (err) {
      console.warn(`[Mercer Executor] Full-exit snap skipped: ${err.message}`);
    }
  }

  // ── Get quote ──────────────────────────────────────────────────────────────
  const label = `${fromAsset} → ${toAsset}`;
  console.log(`[Mercer Executor] ${ts()} — Quote request — SWAP ${label}`);
  console.log(`[Mercer Executor]   inputMint:   ${inputMint}  (${fromAsset})`);
  console.log(`[Mercer Executor]   outputMint:  ${outputMint}  (${toAsset})`);
  console.log(`[Mercer Executor]   amount:      ${rawAmount} (raw) = $${amountUsd} USD`);

  const fromCap    = market[fromAsset]?.marketCapUsd ?? Infinity;
  const toCap      = market[toAsset]?.marketCapUsd   ?? Infinity;
  const isMicroCap = fromCap < 5_000_000 || toCap < 5_000_000;
  const slippageBps = isMicroCap ? 500 : 100;

  let quote;
  try {
    quote = await jupiterApi.quoteGet({ inputMint, outputMint, amount: rawAmount, slippageBps });
  } catch (err) {
    let body = '';
    try { body = err.response ? await err.response.text() : ''; } catch { body = '(could not read response body)'; }
    const msg = `Jupiter quote failed for swap ${label}: ${err.message} — ${body}`;
    console.error(`[Mercer Executor] Quote FAILED for SWAP ${label}: ${err.message} — ${body}`);
    if (body.includes('TOKEN_NOT_TRADABLE')) { addToBlockedBuys(toAsset); addToBlockedBuys(fromAsset); }
    await sendAlert(`Warning: Swap skipped — ${msg}`);
    return { ...trade, status: 'blocked', reason: msg };
  }

  console.log(
    `[Mercer Executor] ${ts()} — Quote — SWAP ${label}` +
    ` | in: ${quote.inAmount} | out: ${quote.outAmount}` +
    ` | price impact: ${quote.priceImpactPct}%`
  );

  // ── Price impact guard ─────────────────────────────────────────────────────
  const maxImpact   = parseFloat(process.env.MAX_PRICE_IMPACT_PCT) || 2.0;
  const priceImpact = parseFloat(quote.priceImpactPct ?? 0);
  if (priceImpact > maxImpact) {
    const msg = `Price impact ${priceImpact.toFixed(2)}% exceeds ${maxImpact}% limit for SWAP ${label} $${amountUsd} — trade blocked`;
    console.warn(`[Mercer Executor] BLOCKED — ${msg}`);
    await sendAlert(`Warning: ${msg}`);
    return { ...trade, status: 'blocked', reason: msg };
  }

  if (DRY_RUN) {
    console.log(`[Mercer Executor] ${ts()} — DRY_RUN=true — skipping broadcast for swap ${label} $${amountUsd}`);
    return { ...trade, status: 'dry_run', quote };
  }

  // ── Pre-flight checks ──────────────────────────────────────────────────────
  if (!process.env.SOLANA_RPC_URL) throw new Error('SOLANA_RPC_URL not set — required for live execution.');
  {
    const minSolForGas = parseFloat(process.env.MIN_SOL_FOR_GAS) || 0.01;
    const keypair      = loadKeypair();
    const connection   = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');

    const lamports = await connection.getBalance(keypair.publicKey);
    if (lamports / 1e9 < minSolForGas) {
      const msg = `Insufficient SOL for gas: ${(lamports / 1e9).toFixed(4)} SOL < ${minSolForGas} minimum`;
      console.error(`[Mercer Executor] ${msg}`);
      await sendAlert(`Warning: ${msg}`);
      return { ...trade, status: 'blocked', reason: msg };
    }

    // Balance check for fromAsset — ensure we actually hold enough to swap
    const { value: fromAccounts } = await connection.getParsedTokenAccountsByOwner(
      keypair.publicKey,
      { mint: new PublicKey(inputMint) }
    );
    const fromBalance = fromAccounts[0]?.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
    const requiredTokens = amountUsd / fromPrice;
    if (fromBalance < requiredTokens * 0.99) { // 1% tolerance for rounding
      const msg = `Insufficient ${fromAsset}: ${fromBalance.toFixed(6)} available < ${requiredTokens.toFixed(6)} required — swap blocked`;
      console.error(`[Mercer Executor] ${msg}`);
      await sendAlert(`Warning: ${msg}`);
      return { ...trade, status: 'blocked', reason: msg };
    }
  }

  // ── Build + broadcast swap transaction ────────────────────────────────────
  try {
    const keypair = loadKeypair();
    const swapResult = await jupiterApi.swapPost({
      swapRequest: {
        quoteResponse:           quote,
        userPublicKey:           keypair.publicKey.toBase58(),
        wrapAndUnwrapSol:        true,
        dynamicComputeUnitLimit: true,
      },
    });

    const tx = VersionedTransaction.deserialize(Buffer.from(swapResult.swapTransaction, 'base64'));
    tx.sign([keypair]);

    const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
    const txid = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    await connection.confirmTransaction(txid, 'confirmed');

    console.log(`[Mercer Executor] ${ts()} — Confirmed — SWAP ${label} | tx: https://solscan.io/tx/${txid}`);
    signalTrade();
    return { ...trade, status: 'executed', txid };

  } catch (err) {
    console.error(`[Mercer Executor] Swap execution failed for ${label}:`, err.message);
    await sendAlert(`Warning: Swap FAILED — ${label} $${amountUsd} — ${err.message}`);
    return { ...trade, status: 'failed', error: err.message };
  }
}

// ─── Single trade executor ────────────────────────────────────────────────────
async function executeTrade(trade, market, jupiterApi) {
  const { type, asset } = trade;
  let amountUsd = trade.amountUsd;

  // Delegate token-to-token swaps to dedicated handler
  if (type === 'swap') {
    return executeSwapTrade(trade, market, jupiterApi);
  }

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

  // ── Pump.fun bonding curve buy ─────────────────────────────────────────────
  // Pre-graduation tokens route through the bonding curve, not Jupiter.
  // Buys spend SOL directly (not USDC) — proceeds from sells land as SOL.
  if (type === 'buy' && market[asset]?._pumpfun) {
    const solPrice = market['SOL']?.price;
    if (!solPrice) {
      const msg = `No SOL price available — cannot calculate pump.fun buy amount for ${asset}`;
      console.error(`[Mercer Executor] ${msg}`);
      return { ...trade, status: 'blocked', reason: msg };
    }
    const minTradeUsd      = parseFloat(process.env.MIN_TRADE_USD) || 3;
    const _maxTradeForPump = parseFloat(process.env.MAX_TRADE_USD) || 35;
    // PUMP_MAX_USD: explicit env override, else 30% of MAX_TRADE_USD (min $5)
    // Scales automatically as portfolio grows and MAX_TRADE_USD is raised
    const pumpMaxUsd  = parseFloat(process.env.PUMP_MAX_USD) || Math.max(5, _maxTradeForPump * 0.30);
    const spendUsd    = Math.min(amountUsd, pumpMaxUsd);
    if (spendUsd < minTradeUsd) {
      return { ...trade, status: 'skipped', reason: `Pump.fun buy $${spendUsd.toFixed(2)} below $${minTradeUsd} minimum` };
    }
    if (DRY_RUN) {
      console.log(`[Mercer Executor] ${ts()} — DRY_RUN — pump.fun BUY ${asset} $${spendUsd} (${(spendUsd / solPrice).toFixed(4)} SOL)`);
      return { ...trade, status: 'dry_run', route: 'pumpfun' };
    }
    try {
      const keypair    = loadKeypair();
      const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
      // Pre-flight: ensure enough SOL to cover buy + gas reserve
      const minSolValueUsd  = parseFloat(process.env.MIN_SOL_VALUE_USD) || 5;
      const reserveLamports = Math.ceil((minSolValueUsd / solPrice) * 1e9);
      const solBalance      = await connection.getBalance(keypair.publicKey);
      const spendLamports   = Math.ceil((spendUsd / solPrice) * 1e9);
      if (solBalance < spendLamports + reserveLamports) {
        const availableUsd = ((solBalance - reserveLamports) / 1e9) * solPrice;
        const msg = `Insufficient SOL for pump.fun buy: $${availableUsd.toFixed(2)} available after $${minSolValueUsd} reserve — need $${spendUsd}`;
        console.warn(`[Mercer Executor] BLOCKED — ${msg}`);
        return { ...trade, status: 'blocked', reason: msg };
      }
      const result     = await pumpFunBuy(assetMint, spendUsd, solPrice, keypair, connection);
      console.log(`[Mercer Executor] ${ts()} — Confirmed — PUMP BUY ${asset} $${spendUsd} | tx: https://solscan.io/tx/${result.txid}`);
      signalTrade();
      // Register with pump monitor for trailing stop / ladder tracking
      const entryPrice = market[asset]?.price ?? (spendUsd / (result.tokensOut / 1e6));
      recordPumpBuy(asset, assetMint, entryPrice, spendUsd);
      return { ...trade, status: 'executed', txid: result.txid, route: 'pumpfun', tokensOut: result.tokensOut };
    } catch (err) {
      console.error(`[Mercer Executor] Pump.fun buy failed for ${asset}:`, err.message);
      // If graduated, fall through to Jupiter
      if (err.message.includes('graduated')) {
        console.log(`[Mercer Executor] ${asset} graduated — routing buy through Jupiter`);
        // fall through below — Jupiter path will handle it
      } else {
        await sendAlert(`Warning: Pump.fun BUY failed — ${asset} $${spendUsd} — ${err.message}`);
        return { ...trade, status: 'failed', error: err.message, route: 'pumpfun' };
      }
    }
  }

  // ── MIN_TRADE_USD floor — skip tiny trades not worth the gas ──────────────
  const minTradeUsd = parseFloat(process.env.MIN_TRADE_USD) || 3;
  if (amountUsd < minTradeUsd) {
    const msg = `Trade too small: $${amountUsd.toFixed(2)} is below $${minTradeUsd} minimum — skipped to avoid wasting gas`;
    console.log(`[Mercer Executor] ${msg}`);
    return { ...trade, status: 'skipped', reason: msg };
  }

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
    if (type === 'buy') {
      rawAmount = Math.round(amountUsd * Math.pow(10, USDC_DECIMALS));
    } else {
      const price = market[asset]?.price;
      if (price) rawAmount = Math.round((amountUsd / price) * Math.pow(10, assetDecimals));
    }
  }

  // ── SOL sell reserve — keep $4 in SOL at all times (gas + buffer) ──────────
  // Reserve = max(MIN_SOL_FOR_GAS lamports, $MIN_SOL_VALUE_USD worth of SOL).
  // This prevents both failed simulations and running dry on gas between cycles.
  if (type === 'sell' && asset === 'SOL' && process.env.SOLANA_RPC_URL) {
    try {
      const minSolForGas  = parseFloat(process.env.MIN_SOL_FOR_GAS)    || 0.01;
      const minSolValueUsd = parseFloat(process.env.MIN_SOL_VALUE_USD)  || 4;
      const solPrice       = market['SOL']?.price ?? 0;
      const minSolByValue  = solPrice > 0 ? minSolValueUsd / solPrice : minSolForGas;
      const reserveSol     = Math.max(minSolForGas, minSolByValue);
      const reserveLamports = Math.ceil(reserveSol * 1e9);

      const keypair        = loadKeypair();
      const connection     = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
      const liveBalance    = await connection.getBalance(keypair.publicKey);
      const maxSellLamports = liveBalance - reserveLamports;

      if (maxSellLamports <= 0) {
        const msg = `SOL sell blocked — balance ${(liveBalance / 1e9).toFixed(4)} SOL ($${((liveBalance / 1e9) * solPrice).toFixed(2)}) is at or below $${minSolValueUsd} reserve`;
        console.warn(`[Mercer Executor] BLOCKED — ${msg}`);
        return { ...trade, status: 'blocked', reason: msg };
      }
      if (rawAmount > maxSellLamports) {
        console.log(`[Mercer Executor] SOL sell capped — preserving $${minSolValueUsd} reserve (${reserveSol.toFixed(4)} SOL)`);
        rawAmount = maxSellLamports;
        amountUsd = parseFloat(((rawAmount / 1e9) * solPrice).toFixed(2));
      }
    } catch (err) {
      console.warn(`[Mercer Executor] SOL reserve check skipped: ${err.message}`);
    }
  }

  // ── Full-exit snap for sells — use entire on-chain balance when selling ≥90% ─
  // Prevents dust from price-precision rounding. Only runs in live mode.
  if (type === 'sell' && asset !== 'SOL' && !DRY_RUN && process.env.SOLANA_RPC_URL) {
    try {
      const kp   = loadKeypair();
      const conn = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
      const { value: tokenAccounts } = await conn.getParsedTokenAccountsByOwner(
        kp.publicKey, { mint: new PublicKey(assetMint) }
      );
      const onChainRaw    = tokenAccounts[0]?.account.data.parsed.info.tokenAmount.amount   ?? '0';
      const onChainUi     = tokenAccounts[0]?.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
      const onChainRawInt = Number(onChainRaw);
      if (onChainRawInt > 0 && rawAmount >= Math.floor(onChainRawInt * 0.90)) {
        console.log(`[Mercer Executor] ${ts()} — Full-exit snap: selling entire balance (${onChainUi} ${asset}) to avoid dust`);
        rawAmount = onChainRawInt;
      }
    } catch (err) {
      console.warn(`[Mercer Executor] Full-exit snap skipped: ${err.message}`);
    }
  }

  // ── Get quote ──────────────────────────────────────────────────────────────
  const assetCap    = market[asset]?.marketCapUsd ?? Infinity;
  const slippageBps = assetCap < 5_000_000 ? 500 : 100;
  const quoteParams = { inputMint, outputMint, amount: rawAmount, slippageBps };
  const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${rawAmount}&slippageBps=${slippageBps}`;

  console.log(`[Mercer Executor] ${ts()} — Quote request — ${type.toUpperCase()} ${asset}`);
  console.log(`[Mercer Executor]   URL:         ${quoteUrl}`);
  console.log(`[Mercer Executor]   inputMint:   ${inputMint}`);
  console.log(`[Mercer Executor]   outputMint:  ${outputMint}`);
  console.log(`[Mercer Executor]   amount:      ${rawAmount} (raw) = $${amountUsd} USD`);
  console.log(`[Mercer Executor]   slippageBps: ${slippageBps} (${assetCap < 5_000_000 ? 'micro-cap' : 'standard'})`);

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
    const msg = `Jupiter quote failed for ${type} ${asset}: ${err.message} — ${body}`;
    if (body.includes('TOKEN_NOT_TRADABLE')) {
      addToBlockedBuys(asset);
      // For sells: try pump.fun bonding curve before giving up
      if (type === 'sell' && assetMint && process.env.SOLANA_RPC_URL && !DRY_RUN) {
        try {
          const keypair    = loadKeypair();
          const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
          const onCurve    = await isOnBondingCurve(assetMint, connection);
          if (onCurve) {
            console.log(`[Mercer Executor] ${ts()} — ${asset} TOKEN_NOT_TRADABLE on Jupiter, attempting pump.fun sell`);
            const { value: tokenAccounts } = await connection.getParsedTokenAccountsByOwner(
              keypair.publicKey, { mint: new PublicKey(assetMint) }
            );
            const rawBal = tokenAccounts[0]?.account.data.parsed.info.tokenAmount.amount ?? '0';
            if (BigInt(rawBal) > 0n) {
              const result = await pumpFunSell(assetMint, BigInt(rawBal), keypair, connection);
              console.log(`[Mercer Executor] ${ts()} — Confirmed — PUMP SELL ${asset} | tx: https://solscan.io/tx/${result.txid}`);
              signalTrade();
              return { ...trade, status: 'executed', txid: result.txid, route: 'pumpfun' };
            }
          }
        } catch (pfErr) {
          console.warn(`[Mercer Executor] Pump.fun sell fallback failed: ${pfErr.message}`);
        }
      }
    }
    await sendAlert(`Warning: Trade skipped — ${msg}`);
    return { ...trade, status: 'blocked', reason: msg };
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
        quoteResponse:           quote,
        userPublicKey:           keypair.publicKey.toBase58(),
        wrapAndUnwrapSol:        true,
        dynamicComputeUnitLimit: true,
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
    if (type === 'sell') removePumpPosition(asset); // clean up pump monitor if this was a tracked position
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
