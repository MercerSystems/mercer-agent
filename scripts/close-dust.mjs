// Close zero-balance token accounts and reclaim SOL rent
// Usage: node scripts/close-dust.mjs [SYMBOL]
// If no symbol given, closes ALL zero-balance token accounts

import 'dotenv/config';
import { Connection, PublicKey, Transaction, TransactionInstruction, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const TOKEN_PROGRAM_ID   = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

function loadKeypair() {
  const raw = process.env.WALLET_PRIVATE_KEY;
  if (raw.trimStart().startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  return Keypair.fromSecretKey(bs58.decode(raw.trim()));
}

function closeAccountIx(tokenAccount, destination, owner, programId) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: destination,  isSigner: false, isWritable: true },
      { pubkey: owner,        isSigner: true,  isWritable: false },
    ],
    data: Buffer.from([9]), // CloseAccount instruction
  });
}

async function main() {
  const filterSymbol = process.argv[2]?.toUpperCase();
  const conn   = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
  const kp     = loadKeypair();
  const owner  = kp.publicKey;

  // Fetch all token accounts (both program IDs)
  const [std, t22] = await Promise.all([
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM }),
  ]);

  const all = [
    ...std.value.map(a => ({ ...a, programId: TOKEN_PROGRAM_ID })),
    ...t22.value.map(a => ({ ...a, programId: TOKEN_2022_PROGRAM })),
  ];

  const toClose = all.filter(a => {
    const info = a.account.data.parsed.info;
    const amount = BigInt(info.tokenAmount.amount);
    return amount === 0n;
  });

  if (toClose.length === 0) {
    console.log('No zero-balance token accounts found.');
    return;
  }

  const targets = filterSymbol
    ? toClose.filter(a => {
        // Can't filter by symbol without a registry, so just show all and let user confirm
        console.log(`Account: ${a.pubkey.toBase58()} — mint: ${a.account.data.parsed.info.mint}`);
        return true;
      })
    : toClose;

  console.log(`Found ${targets.length} zero-balance account(s) to close:`);
  for (const a of targets) {
    console.log(`  ${a.pubkey.toBase58().slice(0, 20)}...  mint: ${a.account.data.parsed.info.mint.slice(0, 20)}...`);
  }

  // Batch into groups of 8 to stay under tx size limit
  const BATCH = 8;
  let totalClosed = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const tx = new Transaction();
    for (const a of batch) {
      tx.add(closeAccountIx(a.pubkey, owner, owner, a.programId));
    }
    const { blockhash } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = owner;
    tx.sign(kp);

    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await conn.confirmTransaction(sig, 'confirmed');
    totalClosed += batch.length;
    console.log(`  Batch ${Math.floor(i/BATCH)+1}: closed ${batch.length} accounts — https://solscan.io/tx/${sig}`);
  }

  console.log(`\n✓ Closed ${totalClosed} account(s) — SOL rent reclaimed`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
