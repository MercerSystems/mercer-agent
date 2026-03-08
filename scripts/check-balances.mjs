import 'dotenv/config';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const TOKEN_PROGRAM_ID   = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

const raw = process.env.WALLET_PRIVATE_KEY;
const kp  = raw.trimStart().startsWith('[')
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
  : Keypair.fromSecretKey(bs58.decode(raw.trim()));

const conn = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
const [std, t22] = await Promise.all([
  conn.getParsedTokenAccountsByOwner(kp.publicKey, { programId: TOKEN_PROGRAM_ID }),
  conn.getParsedTokenAccountsByOwner(kp.publicKey, { programId: TOKEN_2022_PROGRAM }),
]);

const all = [...std.value, ...t22.value];
console.log(`Total token accounts: ${all.length}`);
console.log('\nNon-zero balances:');
all
  .filter(a => BigInt(a.account.data.parsed.info.tokenAmount.amount) > 0n)
  .forEach(a => {
    const info = a.account.data.parsed.info;
    console.log(`  ${a.pubkey.toBase58().slice(0,20)}...  mint: ${info.mint.slice(0,20)}...  amount: ${info.tokenAmount.uiAmount}`);
  });
