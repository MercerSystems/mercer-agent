// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — pumpfun.js
// Direct pump.fun bonding curve executor.
//
// Handles pre-graduation token buys and sells via the pump.fun program.
// Graduated tokens (complete=true on the curve) should use Jupiter instead.
//
// Flow (buy):
//   1. Fetch global account → fee recipient
//   2. Fetch bonding curve PDA → parse virtual reserves
//   3. Calculate tokens out for the given SOL input
//   4. Build buy instruction (+ idempotent ATA creation)
//   5. Sign and broadcast
//
// Flow (sell):
//   1. Fetch bonding curve PDA → parse virtual reserves
//   2. Calculate SOL out for the given token amount
//   3. Build sell instruction
//   4. Sign and broadcast
// ─────────────────────────────────────────────────────────────────────────────

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';

// ─── Program / account constants ──────────────────────────────────────────────
const PUMP_PROGRAM  = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM   = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bKm');

// Derived from program ID — never hardcode these, let the runtime compute them
const [EVENT_AUTH] = PublicKey.findProgramAddressSync(
  [Buffer.from('__event_authority')],
  PUMP_PROGRAM,
);

// Anchor instruction discriminators (sha256("global:buy/sell")[0:8])
const BUY_IX  = Buffer.from([102,  6, 61,  18,   1, 218, 235, 234]);
const SELL_IX = Buffer.from([ 51, 230, 133, 164,  1, 127, 131, 173]);

// 15% slippage — pump.fun bonding curve prices move fast
const SLIPPAGE_BPS = 1500n;

// ─── Global account cache (fee recipient is stable, no need to re-fetch) ──────
let _global = null;

async function getGlobal(connection) {
  if (_global) return _global;
  const [globalPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('global')],
    PUMP_PROGRAM,
  );
  const info = await connection.getAccountInfo(globalPDA);
  if (!info) throw new Error('[PumpFun] Global account not found — wrong program ID?');
  // Layout (after 8-byte discriminator):
  //   offset  8: initialized (bool, 1 byte)
  //   offset  9: authority   (Pubkey, 32 bytes)
  //   offset 41: feeRecipient (Pubkey, 32 bytes)
  const feeRecipient = new PublicKey(info.data.slice(41, 73));
  _global = { globalPDA, feeRecipient };
  console.log(`[PumpFun] Global loaded — fee recipient: ${feeRecipient.toBase58()}`);
  return _global;
}

// ─── Account derivations ──────────────────────────────────────────────────────

function bondingCurvePDA(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM,
  );
  return pda;
}

function ataAddress(owner, mint) {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  );
  return ata;
}

// ─── Bonding curve state ──────────────────────────────────────────────────────

async function fetchCurve(mint, connection) {
  const pda  = bondingCurvePDA(mint);
  const info = await connection.getAccountInfo(pda);
  if (!info) throw new Error(`[PumpFun] Bonding curve not found for ${mint.toBase58()} — may have graduated`);
  const d    = info.data;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return {
    pda,
    virtualTokenReserves: view.getBigUint64(8,  true),
    virtualSolReserves:   view.getBigUint64(16, true),
    realTokenReserves:    view.getBigUint64(24, true),
    realSolReserves:      view.getBigUint64(32, true),
    tokenTotalSupply:     view.getBigUint64(40, true),
    complete:             d[48] === 1,
  };
}

// ── Math ── constant-product AMM with 1% fee ───────────────────────────────────

function tokensOut(curve, lamports) {
  // Deduct 1% fee from incoming SOL before calculating
  const netSol = (lamports * 9900n) / 10000n;
  return (curve.virtualTokenReserves * netSol) / (curve.virtualSolReserves + netSol);
}

function solOut(curve, tokenAmount) {
  const grossSol = (curve.virtualSolReserves * tokenAmount) / (curve.virtualTokenReserves + tokenAmount);
  // Deduct 1% fee from outgoing SOL
  return (grossSol * 9900n) / 10000n;
}

// ─── Instructions ─────────────────────────────────────────────────────────────

function createATAIdempotent(payer, ata, owner, mint) {
  return new TransactionInstruction({
    keys: [
      { pubkey: payer,                   isSigner: true,  isWritable: true  },
      { pubkey: ata,                     isSigner: false, isWritable: true  },
      { pubkey: owner,                   isSigner: false, isWritable: false },
      { pubkey: mint,                    isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM,           isSigner: false, isWritable: false },
    ],
    programId: ATA_PROGRAM,
    data: Buffer.from([1]), // create_idempotent variant
  });
}

function buyInstruction(accounts, tokenAmount, maxSolCost) {
  const data = Buffer.allocUnsafe(24);
  BUY_IX.copy(data, 0);
  data.writeBigUInt64LE(tokenAmount, 8);
  data.writeBigUInt64LE(maxSolCost,  16);
  return new TransactionInstruction({
    keys: [
      { pubkey: accounts.globalPDA,              isSigner: false, isWritable: false },
      { pubkey: accounts.feeRecipient,           isSigner: false, isWritable: true  },
      { pubkey: accounts.mint,                   isSigner: false, isWritable: false },
      { pubkey: accounts.bondingCurve,           isSigner: false, isWritable: true  },
      { pubkey: accounts.associatedBondingCurve, isSigner: false, isWritable: true  },
      { pubkey: accounts.userATA,                isSigner: false, isWritable: true  },
      { pubkey: accounts.user,                   isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId,         isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM,                   isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,              isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTH,                      isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM,                    isSigner: false, isWritable: false },
    ],
    programId: PUMP_PROGRAM,
    data,
  });
}

function sellInstruction(accounts, tokenAmount, minSolOutput) {
  const data = Buffer.allocUnsafe(24);
  SELL_IX.copy(data, 0);
  data.writeBigUInt64LE(tokenAmount,  8);
  data.writeBigUInt64LE(minSolOutput, 16);
  return new TransactionInstruction({
    keys: [
      { pubkey: accounts.globalPDA,              isSigner: false, isWritable: false },
      { pubkey: accounts.feeRecipient,           isSigner: false, isWritable: true  },
      { pubkey: accounts.mint,                   isSigner: false, isWritable: false },
      { pubkey: accounts.bondingCurve,           isSigner: false, isWritable: true  },
      { pubkey: accounts.associatedBondingCurve, isSigner: false, isWritable: true  },
      { pubkey: accounts.userATA,                isSigner: false, isWritable: true  },
      { pubkey: accounts.user,                   isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId,         isSigner: false, isWritable: false },
      { pubkey: ATA_PROGRAM,                     isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM,                   isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTH,                      isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM,                    isSigner: false, isWritable: false },
    ],
    programId: PUMP_PROGRAM,
    data,
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Buy a pump.fun bonding curve token using SOL from the wallet.
 *
 * @param {string}     mintAddress  - Token mint
 * @param {number}     amountUsd    - USD value to spend
 * @param {number}     solPriceUsd  - Current SOL/USD price
 * @param {Keypair}    keypair      - Signing keypair
 * @param {Connection} connection
 * @returns {Promise<{ txid: string, tokensOut: number, solSpent: number }>}
 */
export async function pumpFunBuy(mintAddress, amountUsd, solPriceUsd, keypair, connection) {
  const mint = new PublicKey(mintAddress);
  const { globalPDA, feeRecipient } = await getGlobal(connection);
  const curve = await fetchCurve(mint, connection);

  if (curve.complete) {
    throw new Error(`[PumpFun] ${mintAddress} has graduated — route through Jupiter`);
  }

  const lamports    = BigInt(Math.floor((amountUsd / solPriceUsd) * 1e9));
  const expectedOut = tokensOut(curve, lamports);
  if (expectedOut <= 0n) throw new Error('[PumpFun] Token output is 0 — trade too small');

  const maxSolCost          = (lamports * (10000n + SLIPPAGE_BPS)) / 10000n;
  const bondingCurve        = curve.pda;
  const assocBondingCurve   = ataAddress(bondingCurve, mint);
  const userATA             = ataAddress(keypair.publicKey, mint);

  const accounts = {
    globalPDA, feeRecipient, mint,
    bondingCurve, associatedBondingCurve: assocBondingCurve,
    userATA, user: keypair.publicKey,
  };

  const tx = new Transaction();
  tx.add(createATAIdempotent(keypair.publicKey, userATA, keypair.publicKey, mint));
  tx.add(buyInstruction(accounts, expectedOut, maxSolCost));

  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = keypair.publicKey;
  tx.sign(keypair);

  const txid = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction(txid, 'confirmed');

  return { txid, tokensOut: Number(expectedOut), solSpent: Number(lamports) / 1e9 };
}

/**
 * Sell a pump.fun bonding curve token back to SOL.
 *
 * @param {string}        mintAddress    - Token mint
 * @param {number|bigint} tokenAmountRaw - On-chain raw token units to sell
 * @param {Keypair}       keypair
 * @param {Connection}    connection
 * @returns {Promise<{ txid: string, solReceived: number }>}
 */
export async function pumpFunSell(mintAddress, tokenAmountRaw, keypair, connection) {
  const mint = new PublicKey(mintAddress);
  const { globalPDA, feeRecipient } = await getGlobal(connection);
  const curve = await fetchCurve(mint, connection);

  if (curve.complete) {
    throw new Error(`[PumpFun] ${mintAddress} has graduated — route through Jupiter`);
  }

  const tokenAmount  = BigInt(tokenAmountRaw);
  const expectedSol  = solOut(curve, tokenAmount);
  const minSolOutput = (expectedSol * (10000n - SLIPPAGE_BPS)) / 10000n;

  const bondingCurve      = curve.pda;
  const assocBondingCurve = ataAddress(bondingCurve, mint);
  const userATA           = ataAddress(keypair.publicKey, mint);

  const accounts = {
    globalPDA, feeRecipient, mint,
    bondingCurve, associatedBondingCurve: assocBondingCurve,
    userATA, user: keypair.publicKey,
  };

  const tx = new Transaction();
  tx.add(sellInstruction(accounts, tokenAmount, minSolOutput));

  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = keypair.publicKey;
  tx.sign(keypair);

  const txid = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction(txid, 'confirmed');

  return { txid, solReceived: Number(expectedSol) / 1e9 };
}

/**
 * Returns true if the token is still on the bonding curve (not yet graduated).
 * Use this to decide whether to route through pump.fun or Jupiter.
 */
export async function isOnBondingCurve(mintAddress, connection) {
  try {
    const curve = await fetchCurve(new PublicKey(mintAddress), connection);
    return !curve.complete;
  } catch {
    return false; // not found = likely graduated or invalid
  }
}
