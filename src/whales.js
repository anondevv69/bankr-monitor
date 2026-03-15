/**
 * Bankr fee-whale leaderboard from Doppler Indexer.
 * Queries cumulatedFees ordered by totalFeesUsd (all-time top fee earners).
 */

import { getClaimTxsFromBaseScan } from "./basescan-claims.js";
import { getClaimedViaTransferLogs } from "./token-stats.js";

const CHAIN_ID = parseInt(process.env.CHAIN_ID || "8453", 10);
const DOPPLER_INDEXER_URL =
  process.env.DOPPLER_INDEXER_URL ||
  (CHAIN_ID === 8453 ? "https://bankr.indexer.doppler.lol" : "https://testnet-indexer.doppler.lol");

/**
 * Fetch top fee earners by totalFeesUsd from the indexer.
 * Tries multiple query shapes: with/without chainId, items vs list (Bankr indexer uses chainId + items).
 * @param {number} [limit=10]
 * @returns {Promise<{ rows: Array<{ wallet: string, totalUsd: number, weth: number }>, source: 'cumulatedFees' | 'v4pools' }>}
 */
export async function fetchTopFeeEarners(limit = 10) {
  const cap = Math.min(Math.max(1, parseInt(limit, 10) || 10), 50);
  const base = DOPPLER_INDEXER_URL.replace(/\/$/, "");

  const variants = [
    // Bankr indexer style: where { chainId }, items, Int chainId
    {
      query: `query TopFeeRecipientsChainId($chainId: Int!, $limit: Int!) {
        cumulatedFees(
          where: { chainId: $chainId }
          orderBy: "totalFeesUsd"
          orderDirection: "desc"
          limit: $limit
        ) {
          items {
            beneficiary
            token0Fees
            token1Fees
            totalFeesUsd
          }
        }
      }`,
      variables: { chainId: CHAIN_ID, limit: cap },
    },
    // Float chainId (some Doppler deployments use Float! for chainId)
    {
      query: `query TopFeeRecipientsChainIdFloat($chainId: Float!, $limit: Int!) {
        cumulatedFees(
          where: { chainId: $chainId }
          orderBy: "totalFeesUsd"
          orderDirection: "desc"
          limit: $limit
        ) {
          items {
            beneficiary
            token0Fees
            token1Fees
            totalFeesUsd
          }
        }
      }`,
      variables: { chainId: CHAIN_ID, limit: cap },
    },
    // No where, items only
    {
      query: `query TopFeeRecipientsItems($limit: Int!) {
        cumulatedFees(
          orderBy: "totalFeesUsd"
          orderDirection: "desc"
          limit: $limit
        ) {
          items {
            beneficiary
            token0Fees
            token1Fees
            totalFeesUsd
          }
        }
      }`,
      variables: { limit: cap },
    },
    // Direct list (no items)
    {
      query: `query TopFeeRecipients($limit: Int!) {
        cumulatedFees(
          orderBy: "totalFeesUsd"
          orderDirection: "desc"
          limit: $limit
        ) {
          beneficiary
          token0Fees
          token1Fees
          totalFeesUsd
        }
      }`,
      variables: { limit: cap },
    },
  ];

  for (const { query, variables } of variants) {
    try {
      const res = await fetch(`${base}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      const json = await res.json().catch(() => ({}));
      if (json.errors?.length) {
        if (process.env.DEBUG_WHALES === "1") {
          console.error("[whales] GraphQL errors:", JSON.stringify(json.errors));
        }
        continue;
      }
      if (!res.ok) continue;

      let list = json.data?.cumulatedFees;
      if (list?.items && Array.isArray(list.items)) {
        list = list.items;
      } else if (!Array.isArray(list)) {
        continue;
      }

      const byWallet = new Map();
      for (const r of list) {
        if (!r?.beneficiary) continue;
        const raw = String(r.beneficiary).trim();
        const w = raw.toLowerCase();
        const usd = r.totalFeesUsd != null ? Number(r.totalFeesUsd) : 0;
        const weth = r.token0Fees != null ? Number(r.token0Fees) / 1e18 : 0;
        const cur = byWallet.get(w);
        if (cur) {
          cur.totalUsd += usd;
          cur.weth += weth;
        } else {
          byWallet.set(w, { wallet: raw, totalUsd: usd, weth });
        }
      }
      const out = Array.from(byWallet.values())
        .sort((a, b) => b.totalUsd - a.totalUsd)
        .slice(0, cap);
      if (out.length > 0) return { rows: out, source: "cumulatedFees" };
    } catch (e) {
      if (process.env.DEBUG_WHALES === "1") {
        console.error("[whales] fetch error:", e.message);
      }
    }
  }

  // Fallback: indexer may not expose global cumulatedFees list; use v4pools by volume and aggregate by beneficiary
  const fallback = await fetchTopFeeEarnersFromV4Pools(base, cap);
  return { rows: fallback, source: "v4pools" };
}

/**
 * Fallback when cumulatedFees list is not available: get v4pools by volumeUsd, aggregate by beneficiary.
 * Shows "top fee recipients by pool volume" (proxy for fee earners).
 */
async function fetchTopFeeEarnersFromV4Pools(base, cap) {
  const query = `
    query V4PoolsByVolume($chainId: Int!, $limit: Int!) {
      v4pools(
        where: { chainId: $chainId }
        orderBy: "volumeUsd"
        orderDirection: "desc"
        limit: $limit
      ) {
        items {
          volumeUsd
          beneficiaries
        }
      }
    }
  `;
  const queryFloat = `
    query V4PoolsByVolumeFloat($chainId: Float!, $limit: Int!) {
      v4pools(
        where: { chainId: $chainId }
        orderBy: "volumeUsd"
        orderDirection: "desc"
        limit: $limit
      ) {
        items {
          volumeUsd
          beneficiaries
        }
      }
    }
  `;
  for (const q of [query, queryFloat]) {
    try {
      const res = await fetch(`${base}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: q,
          variables: { chainId: CHAIN_ID, limit: Math.min(200, cap * 20) },
        }),
      });
      if (!res.ok) continue;
      const json = await res.json().catch(() => ({}));
      if (json.errors?.length) continue;
      const items = json.data?.v4pools?.items ?? [];
      const byWallet = new Map();
      for (const p of items) {
        const vol = p.volumeUsd != null ? Number(p.volumeUsd) : 0;
        const bens = Array.isArray(p.beneficiaries) ? p.beneficiaries : [];
        for (const b of bens) {
          if (!b || typeof b !== "string") continue;
          const raw = String(b).trim();
          const w = raw.toLowerCase();
          const cur = byWallet.get(w);
          if (cur) cur.totalUsd += vol;
          else byWallet.set(w, { wallet: raw, totalUsd: vol, weth: 0 });
        }
      }
      const out = Array.from(byWallet.values())
        .sort((a, b) => b.totalUsd - a.totalUsd)
        .slice(0, cap);
      if (out.length > 0) return out;
    } catch (_) {}
  }
  return [];
}


/**
 * Fetch the most recent fee claim for a token from the indexer (feeClaims).
 * Use this for accurate claim amounts and tx link instead of (previousClaimable - currentClaimable).
 * @param {string} tokenAddress - Token contract address (0x...).
 * @param {string} [beneficiary] - Optional fee recipient address to filter.
 * @returns {Promise<{ amount0: string, amount1: string, weth: number, tokenAmount: number, transactionHash: string|null } | null>}
 */
export async function fetchLatestFeeClaim(tokenAddress, beneficiary) {
  if (!tokenAddress || typeof tokenAddress !== "string") return null;
  const token = tokenAddress.trim().toLowerCase();
  const base = DOPPLER_INDEXER_URL.replace(/\/$/, "");

  const vars = { token };
  if (beneficiary) vars.beneficiary = beneficiary.trim().toLowerCase();

  // Try where: { token }, then where: { baseToken }; support items or direct list
  const queries = [
    `query RecentClaims($token: String!) {
      feeClaims(where: { token: $token }, orderBy: "timestamp", orderDirection: "desc", limit: 1) {
        amount0
        amount1
        transactionHash
        timestamp
      }
    }`,
    `query RecentClaimsItems($token: String!) {
      feeClaims(where: { token: $token }, orderBy: "timestamp", orderDirection: "desc", limit: 1) {
        items { amount0 amount1 transactionHash timestamp }
      }
    }`,
    `query RecentClaimsBaseToken($token: String!) {
      feeClaims(where: { baseToken: $token }, orderBy: "timestamp", orderDirection: "desc", limit: 1) {
        amount0
        amount1
        transactionHash
        timestamp
      }
    }`,
    `query RecentClaimsBaseTokenItems($token: String!) {
      feeClaims(where: { baseToken: $token }, orderBy: "timestamp", orderDirection: "desc", limit: 1) {
        items { amount0 amount1 transactionHash timestamp }
      }
    }`,
  ];

  for (const query of queries) {
    try {
      const res = await fetch(`${base}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: vars }),
      });
      if (!res.ok) continue;
      const json = await res.json();
      if (json.errors?.length) continue;

      let list = json.data?.feeClaims;
      if (list?.items && Array.isArray(list.items)) list = list.items;
      else if (!Array.isArray(list)) continue;

      const r = list[0];
      if (!r || (r.amount0 == null && r.amount1 == null)) continue;

      const amount0 = r.amount0 != null ? BigInt(r.amount0) : 0n;
      const amount1 = r.amount1 != null ? BigInt(r.amount1) : 0n;
      const weth = Number(amount0) / 1e18;
      const tokenAmount = Number(amount1) / 1e18;
      return {
        amount0: String(r.amount0 ?? "0"),
        amount1: String(r.amount1 ?? "0"),
        weth,
        tokenAmount,
        transactionHash: r.transactionHash != null ? String(r.transactionHash).trim() : null,
      };
    } catch (_) {
      /* try next */
    }
  }
  // Fallbacks when indexer has no feeClaims: (1) RPC Transfer logs from locker→wallet, (2) BaseScan txlist
  if (beneficiary && CHAIN_ID === 8453) {
    try {
      const transferLogs = await getClaimedViaTransferLogs(beneficiary);
      if (transferLogs.count > 0 && transferLogs.latestTxHash) {
        return {
          amount0: "0",
          amount1: "0",
          weth: 0,
          tokenAmount: 0,
          transactionHash: transferLogs.latestTxHash,
        };
      }
    } catch (_) {
      /* ignore */
    }
    try {
      const { count, latestTxHash } = await getClaimTxsFromBaseScan(beneficiary, undefined, { limit: 50 });
      if (count > 0 && latestTxHash) {
        return {
          amount0: "0",
          amount1: "0",
          weth: 0,
          tokenAmount: 0,
          transactionHash: latestTxHash,
        };
      }
    } catch (_) {
      /* ignore */
    }
  }
  return null;
}
