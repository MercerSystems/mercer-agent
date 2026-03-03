// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — wallet/solana.js
// Fetches real on-chain token balances via @solana/web3.js RPC
// ─────────────────────────────────────────────────────────────────────────────

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

// Token mint addresses on Solana mainnet
const MINTS = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  JUP:  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF:  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
};

/**
 * Fetches on-chain token balances for a Solana wallet.
 *
 * @param {string} walletAddress - Base58-encoded Solana wallet address
 * @param {string} rpcUrl        - Solana RPC endpoint URL
 * @returns {object} Portfolio shaped like DEFAULT_BASE_PORTFOLIO
 */
export async function fetchWalletPortfolio(walletAddress, rpcUrl) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const pubkey = new PublicKey(walletAddress);

  // Fetch native SOL balance
  const lamports = await connection.getBalance(pubkey);
  const solBalance = lamports / LAMPORTS_PER_SOL;

  // Fetch SPL token balances in parallel
  const [usdcBalance, jupBalance, bonkBalance, wifBalance] = await Promise.all(
    ['USDC', 'JUP', 'BONK', 'WIF'].map(async (symbol) => {
      const mint = new PublicKey(MINTS[symbol]);
      const accounts = await connection.getParsedTokenAccountsByOwner(pubkey, { mint });
      if (accounts.value.length === 0) return 0;
      const { amount, decimals } = accounts.value[0].account.data.parsed.info.tokenAmount;
      return Number(amount) / Math.pow(10, decimals);
    })
  );

  return {
    walletAddress,
    peakValueUsd: 0,
    cashUsd: usdcBalance,
    holdings: [
      { symbol: 'SOL',  quantity: solBalance,  entryPrice: null },
      { symbol: 'JUP',  quantity: jupBalance,  entryPrice: null },
      { symbol: 'BONK', quantity: bonkBalance, entryPrice: null },
      { symbol: 'WIF',  quantity: wifBalance,  entryPrice: null },
    ],
  };
}
