// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — wallet/solana.js
// Fetches all on-chain token balances via @solana/web3.js RPC.
// Dynamically detects every SPL token in the wallet — no hardcoded mint list.
// ─────────────────────────────────────────────────────────────────────────────

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { resolveMint } from '../market/token-registry.js';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/**
 * Fetches all on-chain token balances for a Solana wallet.
 * Returns every token with a non-zero balance, resolved to a symbol via
 * the Jupiter verified token list. Unknown tokens (not in Jupiter's list)
 * are skipped since Mercer can't price or trade them.
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

  // Fetch all SPL token accounts in one call
  const { value: tokenAccounts } = await connection.getParsedTokenAccountsByOwner(
    pubkey,
    { programId: TOKEN_PROGRAM_ID }
  );

  // Resolve each non-zero token account to a symbol
  const splHoldings = [];
  await Promise.all(
    tokenAccounts.map(async (acct) => {
      const info     = acct.account.data.parsed.info;
      const mint     = info.mint;
      const { uiAmount } = info.tokenAmount;

      if (!uiAmount || uiAmount <= 0) return; // skip zero balances

      const tokenMeta = resolveMint(mint);
      if (!tokenMeta) return; // skip unknown / unverified tokens

      splHoldings.push({
        symbol:     tokenMeta.symbol,
        quantity:   uiAmount,
        entryPrice: null,
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
