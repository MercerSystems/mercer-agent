// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — wallet/solana.js
// Fetches all on-chain token balances via @solana/web3.js RPC.
// Dynamically detects every SPL token in the wallet — no hardcoded mint list.
// ─────────────────────────────────────────────────────────────────────────────

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { resolveMint } from '../market/token-registry.js';

const TOKEN_PROGRAM_ID   = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

/**
 * Fetches all on-chain token balances for a Solana wallet.
 * Queries both the classic SPL Token program and Token-2022 so tokens like
 * BIO (which use the newer program) are always included.
 *
 * @param {string} walletAddress - Base58-encoded Solana wallet address
 * @param {string} rpcUrl        - Solana RPC endpoint URL
 * @returns {object} Portfolio shaped like DEFAULT_BASE_PORTFOLIO
 */
export async function fetchWalletPortfolio(walletAddress, rpcUrl) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const pubkey     = new PublicKey(walletAddress);

  // Fetch native SOL balance
  const lamports   = await connection.getBalance(pubkey);
  const solBalance = lamports / LAMPORTS_PER_SOL;

  // Fetch token accounts from both Token programs in parallel
  const [{ value: classicAccounts }, { value: t22Accounts }] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_2022_PROGRAM }),
  ]);
  const tokenAccounts = [...classicAccounts, ...t22Accounts];

  // Resolve each non-zero token account to a symbol
  const splHoldings = [];
  await Promise.all(
    tokenAccounts.map(async (acct) => {
      const info     = acct.account.data.parsed.info;
      const mint     = info.mint;
      const { uiAmount } = info.tokenAmount;

      if (!uiAmount || uiAmount <= 0) return; // skip zero balances

      const tokenMeta = resolveMint(mint);
      // Include unknown tokens — portfolio route will price them by mint via CoinGecko
      splHoldings.push({
        symbol:     tokenMeta?.symbol ?? null, // null = unrecognised, resolved later
        mint,                                  // always carry raw mint for price fallback
        quantity:   uiAmount,
        entryPrice: null,
        unknown:    !tokenMeta,
      });
    })
  );

  // Always include SOL (needed for gas even if near-zero)
  const holdings = [
    { symbol: 'SOL', quantity: solBalance, entryPrice: null },
    ...splHoldings,
  ];

  return { walletAddress, peakValueUsd: 0, cashUsd: 0, holdings };
}
