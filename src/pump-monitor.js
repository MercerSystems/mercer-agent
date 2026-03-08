// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — pump-monitor.js
// Dedicated 60s monitor for pump.fun positions.
//
// Runs independently of the reasoning cycle — Claude checks every 15 min,
// this watches every 60s. Catches pumps and rugs before Claude can react.
//
// Exit rules (evaluated in order, first match wins):
//   1. Time exit    — held ≥ 6h → sell all (pump.fun tokens don't consolidate)
//   2. Entry stop   — price ≤ entry × 0.92 (-8%) → sell all
//   3. Trailing stop — once peak is 20%+ above entry, stop follows at peak × 0.80
//   4. Profit ladder — +50%: sell 50% | +100%: sell remaining
//
// On sell: tries pump.fun bonding curve first (if not graduated), falls back
// to Jupiter if the token has graduated during the hold.
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { Connection, PublicKey, VersionedTransaction, Keypair } from '@solana/web3.js';
import { createJupiterApiClient } from '@jup-ag/api';
import bs58 from 'bs58';
import { pumpFunSell, isOnBondingCurve } from './pumpfun.js';
import { sendAlert } from './notify.js';
import { signalTrade } from './trade-signal.js';

// ─── Config ───────────────────────────────────────────────────────────────────
const MONITOR_INTERVAL_MS  = 60_000; // check every 60s
const PUMP_ENTRY_STOP_PCT  = -0.08;  // -8% from entry → sell all
const PUMP_TRAIL_ACTIVATE  =  0.20;  // trailing stop only arms after +20% gain
const PUMP_TRAIL_DROP_PCT  =  0.20;  // stop fires if price drops 20% from peak
const PUMP_MAX_HOLD_HOURS  =  6;     // time-based exit at 6h
const PUMP_LADDER = [
  { gainPct: 0.50, sellFraction: 0.50, label: '+50%' },
  { gainPct: 1.00, sellFraction: 1.00, label: '+100%' },
];

const POSITIONS_FILE = join(process.cwd(), 'data', 'pump-positions.json');
const USDC_MINT      = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ─── Position state ───────────────────────────────────────────────────────────
// {
//   [symbol]: {
//     mint:           string,
//     entryPrice:     number,
//     entryTime:      number (ms),
//     entryAmountUsd: number,
//     peakPrice:      number,
//     rungsSold:      boolean[],  // one per PUMP_LADDER entry
//   }
// }

function loadPositions() {
  try { return JSON.parse(readFileSync(POSITIONS_FILE, 'utf8')); }
  catch { return {}; }
}

function savePositions(pos) {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(POSITIONS_FILE, JSON.stringify(pos, null, 2));
  } catch (err) {
    console.warn(`[PumpMonitor] Save failed: ${err.message}`);
  }
}

// ─── Public: called by executor after a successful pump.fun buy ───────────────
export function recordPumpBuy(symbol, mint, entryPrice, amountUsd) {
  if (!entryPrice || entryPrice <= 0) return;
  const positions = loadPositions();
  positions[symbol] = {
    mint,
    entryPrice,
    entryTime:      Date.now(),
    entryAmountUsd: amountUsd,
    peakPrice:      entryPrice,
    rungsSold:      PUMP_LADDER.map(() => false),
  };
  savePositions(positions);
  console.log(`[PumpMonitor] Tracking ${symbol} @ $${entryPrice} (mint: ${mint})`);
}

export function removePumpPosition(symbol) {
  const positions = loadPositions();
  if (!positions[symbol]) return;
  delete positions[symbol];
  savePositions(positions);
  console.log(`[PumpMonitor] Removed position: ${symbol}`);
}

// ─── Keypair loader (same logic as executor.js) ───────────────────────────────
function loadKeypair() {
  const raw = process.env.WALLET_PRIVATE_KEY;
  if (!raw) throw new Error('WALLET_PRIVATE_KEY not set');
  if (raw.trimStart().startsWith('[')) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  return Keypair.fromSecretKey(bs58.decode(raw.trim()));
}

// ─── Price fetch via DexScreener ─────────────────────────────────────────────
async function fetchMintPrice(mint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = (data.pairs ?? [])
      .filter(p => p.chainId === 'solana' && p.priceUsd)
      .sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0));
    return pairs[0] ? parseFloat(pairs[0].priceUsd) : null;
  } catch {
    return null;
  }
}

// ─── Sell executor ────────────────────────────────────────────────────────────
// fraction: 0.0–1.0 of CURRENT on-chain balance to sell
const _inFlight = new Set();

async function executeSell(symbol, pos, fraction, reason) {
  if (_inFlight.has(symbol)) return false;
  _inFlight.add(symbol);
  try {
    const DRY_RUN    = process.env.DRY_RUN !== 'false';
    const keypair    = loadKeypair();
    const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');

    // Get current on-chain balance
    const { value: accts } = await connection.getParsedTokenAccountsByOwner(
      keypair.publicKey, { mint: new PublicKey(pos.mint) },
    );
    const rawBalance = BigInt(accts[0]?.account.data.parsed.info.tokenAmount.amount ?? '0');
    if (rawBalance === 0n) {
      console.log(`[PumpMonitor] ${symbol}: zero balance — removing`);
      removePumpPosition(symbol);
      return true;
    }

    const sellRaw = fraction >= 1.0
      ? rawBalance
      : (rawBalance * BigInt(Math.round(fraction * 10000))) / 10000n;

    if (sellRaw === 0n) return false;

    console.log(`[PumpMonitor] ${symbol} — ${reason} → selling ${(fraction * 100).toFixed(0)}% (${sellRaw} raw)`);

    if (DRY_RUN) {
      console.log(`[PumpMonitor] DRY_RUN — skipping sell for ${symbol}`);
      return false;
    }

    let txid;
    const onCurve = await isOnBondingCurve(pos.mint, connection);

    if (onCurve) {
      // Still on bonding curve — use pump.fun sell
      const result = await pumpFunSell(pos.mint, sellRaw, keypair, connection);
      txid = result.txid;
    } else {
      // Graduated — use Jupiter
      const jup   = createJupiterApiClient();
      const quote = await jup.quoteGet({
        inputMint:   pos.mint,
        outputMint:  USDC_MINT,
        amount:      Number(sellRaw),
        slippageBps: 500,
      });
      const swap = await jup.swapPost({
        swapRequest: {
          quoteResponse:           quote,
          userPublicKey:           keypair.publicKey.toBase58(),
          wrapAndUnwrapSol:        true,
          dynamicComputeUnitLimit: true,
        },
      });
      const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
      tx.sign([keypair]);
      txid = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
      await connection.confirmTransaction(txid, 'confirmed');
    }

    console.log(`[PumpMonitor] ✓ ${symbol} sold — ${reason} | https://solscan.io/tx/${txid}`);
    await sendAlert(`[PumpMonitor] ${symbol} sold — ${reason}`);
    signalTrade();
    return true;

  } catch (err) {
    console.error(`[PumpMonitor] Sell failed for ${symbol}: ${err.message}`);
    return false;
  } finally {
    _inFlight.delete(symbol);
  }
}

// ─── Monitor tick ─────────────────────────────────────────────────────────────
async function tick() {
  const positions = loadPositions();
  const symbols   = Object.keys(positions);
  if (symbols.length === 0) return;

  console.log(`[PumpMonitor] Checking ${symbols.length} position(s): ${symbols.join(', ')}`);

  for (const symbol of symbols) {
    if (_inFlight.has(symbol)) continue;

    const pos = positions[symbol];
    const currentPrice = await fetchMintPrice(pos.mint);

    if (!currentPrice) {
      console.warn(`[PumpMonitor] ${symbol}: price unavailable — skipping`);
      continue;
    }

    const entry     = pos.entryPrice;
    const peak      = Math.max(pos.peakPrice ?? entry, currentPrice);
    const gainPct   = (currentPrice - entry) / entry;
    const fromPeak  = (currentPrice - peak) / peak;
    const heldHours = (Date.now() - pos.entryTime) / 3_600_000;

    // Update peak price
    if (currentPrice > (pos.peakPrice ?? 0)) {
      pos.peakPrice = currentPrice;
      positions[symbol] = pos;
      savePositions(positions);
    }

    const gainStr  = `${gainPct >= 0 ? '+' : ''}${(gainPct * 100).toFixed(1)}%`;
    const peakStr  = `peak: ${(((peak - entry) / entry) * 100).toFixed(1)}%`;
    const holdStr  = `${heldHours.toFixed(1)}h held`;
    console.log(`[PumpMonitor] ${symbol.padEnd(10)} $${currentPrice.toPrecision(4)} | ${gainStr} | ${peakStr} | fromPeak: ${(fromPeak * 100).toFixed(1)}% | ${holdStr}`);

    // ── 1. Time-based exit ────────────────────────────────────────────────────
    if (heldHours >= PUMP_MAX_HOLD_HOURS) {
      const sold = await executeSell(symbol, pos, 1.0, `time exit (${heldHours.toFixed(1)}h held)`);
      if (sold) { removePumpPosition(symbol); continue; }
    }

    // ── 2. Entry stop-loss ────────────────────────────────────────────────────
    if (gainPct <= PUMP_ENTRY_STOP_PCT) {
      const sold = await executeSell(symbol, pos, 1.0, `entry stop (${gainStr})`);
      if (sold) { removePumpPosition(symbol); continue; }
    }

    // ── 3. Trailing stop (arms after PUMP_TRAIL_ACTIVATE gain) ───────────────
    const trailArmed = peak >= entry * (1 + PUMP_TRAIL_ACTIVATE);
    if (trailArmed && fromPeak <= -PUMP_TRAIL_DROP_PCT) {
      const peakGain = (((peak - entry) / entry) * 100).toFixed(0);
      const sold = await executeSell(symbol, pos, 1.0, `trailing stop (peak was +${peakGain}%, now ${(fromPeak * 100).toFixed(1)}% from peak)`);
      if (sold) { removePumpPosition(symbol); continue; }
    }

    // ── 4. Profit ladder (highest rung first to avoid double-sells) ───────────
    // Check from highest rung downward — if +100% triggers, skip the +50% rung
    let ladderFired = false;
    for (let i = PUMP_LADDER.length - 1; i >= 0; i--) {
      const rung = PUMP_LADDER[i];
      if (pos.rungsSold[i] || gainPct < rung.gainPct) continue;

      const sold = await executeSell(symbol, pos, rung.sellFraction, `take-profit ${rung.label}`);
      if (sold) {
        // Only persist rung state after a confirmed sell — prevents dry-run / failed sells consuming rungs
        for (let j = 0; j <= i; j++) pos.rungsSold[j] = true;
        positions[symbol] = pos;
        savePositions(positions);
        if (rung.sellFraction >= 1.0) removePumpPosition(symbol);
      }
      ladderFired = true;
      break;
    }
    if (ladderFired) continue;
  }
}

// ─── Public: start the monitor ────────────────────────────────────────────────
export function startPumpMonitor() {
  if (!process.env.SOLANA_RPC_URL || !process.env.WALLET_PRIVATE_KEY) {
    console.log('[PumpMonitor] Missing SOLANA_RPC_URL or WALLET_PRIVATE_KEY — monitor disabled');
    return;
  }
  console.log(`[PumpMonitor] Started — 60s interval | trail: -${PUMP_TRAIL_DROP_PCT * 100}% from peak | ladder: ${PUMP_LADDER.map(r => r.label).join(' / ')}`);
  tick().catch(err => console.error('[PumpMonitor] Initial tick error:', err.message));
  setInterval(() => tick().catch(err => console.error('[PumpMonitor] tick error:', err.message)), MONITOR_INTERVAL_MS);
}
