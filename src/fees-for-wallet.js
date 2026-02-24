#!/usr/bin/env node
/**
 * Aggregate accrued/claimable-style fees for a wallet (or X/FC) as fee recipient.
 * Uses lookup (by fee) + Doppler indexer cumulatedFees when available.
 *
 * Usage: node src/fees-for-wallet.js <wallet|@x|fc_handle>
 * Export: getFeesSummary(query) for Discord /fees.
 */

import "dotenv/config";
import { lookupByDeployerOrFee } from "./lookup-deployer.js";
import { fetchPoolByBaseToken, fetchCumulatedFees, formatUsd } from "./token-stats.js";

/**
 * Get aggregated fees for a wallet or X/Farcaster handle (as fee recipient).
 * @returns { Promise<{ totalUsd: number, tokens: Array<{ tokenAddress, tokenName, tokenSymbol, totalFeesUsd }>, indexerUsed: boolean, feeWallet: string|null, error?: string }> }
 */
export async function getFeesSummary(query) {
  const { matches } = await lookupByDeployerOrFee(query, "fee");
  if (matches.length === 0) {
    return { totalUsd: 0, tokens: [], matchCount: 0, indexerUsed: false, feeWallet: null, error: "No tokens found where this wallet or handle is fee recipient." };
  }

  const feeWallet = matches[0].feeRecipientWallet?.toLowerCase() ?? null;
  const tokens = [];
  let totalUsd = 0;

  const DECIMALS = 18; // token and WETH typically 18
  for (const m of matches) {
    const pool = await fetchPoolByBaseToken(m.tokenAddress);
    if (!pool) continue;
    const fees = await fetchCumulatedFees(pool.id ?? pool.address, feeWallet ?? m.feeRecipientWallet);
    if (!fees || (fees.token0Fees == null && fees.token1Fees == null && fees.totalFeesUsd == null)) continue;
    const usd = fees.totalFeesUsd != null ? Number(fees.totalFeesUsd) : 0;
    totalUsd += usd;
    // Pool base token = launch token (token0); quote = typically WETH (token1). Raw amounts in wei.
    const rawToken = fees.token0Fees != null ? BigInt(fees.token0Fees) : 0n;
    const rawWeth = fees.token1Fees != null ? BigInt(fees.token1Fees) : 0n;
    const tokenAmount = Number(rawToken) / 10 ** DECIMALS;
    const wethAmount = Number(rawWeth) / 10 ** DECIMALS;
    tokens.push({
      tokenAddress: m.tokenAddress,
      tokenName: m.tokenName,
      tokenSymbol: m.tokenSymbol,
      totalFeesUsd: usd,
      tokenAmount,
      wethAmount,
      rawToken: raw0.toString(),
      rawWeth: raw1.toString(),
    });
  }

  return {
    totalUsd,
    tokens,
    matchCount: matches.length,
    indexerUsed: tokens.length > 0,
    feeWallet,
    formatUsd,
  };
}

async function main() {
  const query = process.argv[2];
  if (!query) {
    console.log("Usage: node src/fees-for-wallet.js <wallet|@x|fc_handle>");
    process.exit(1);
  }
  const out = await getFeesSummary(query);
  if (out.error) {
    console.log(out.error);
    console.log("Full search: https://bankr.bot/launches/search?q=" + encodeURIComponent(query));
    return;
  }
  console.log("Fee recipient (resolved):", out.feeWallet ?? "—");
  console.log("Tokens as fee recipient:", out.matchCount ?? out.tokens.length);
  if (out.indexerUsed) {
    console.log("Total accrued (USD, from indexer):", out.formatUsd(out.totalUsd) ?? out.totalUsd.toFixed(2));
    out.tokens.forEach((t) => {
      console.log(`  ${t.tokenName} ($${t.tokenSymbol}): ${out.formatUsd(t.totalFeesUsd) ?? t.totalFeesUsd}`);
    });
    console.log("\nClaim via Bankr app or: bankr fees claim <tokenAddress>");
  } else {
    console.log("Indexer did not return cumulated fees for these tokens. Set DOPPLER_INDEXER_URL to an indexer that supports cumulatedFees.");
    console.log("Or run: bankr fees --token <tokenAddress> for each token.");
  }
}

const isRunDirectly = process.argv[1]?.includes("fees-for-wallet");
if (isRunDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
