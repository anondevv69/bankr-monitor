/**
 * Bankr fee-whale leaderboard from Doppler Indexer.
 * Queries cumulatedFees ordered by totalFeesUsd (all-time top fee earners).
 */

const CHAIN_ID = parseInt(process.env.CHAIN_ID || "8453", 10);
const DOPPLER_INDEXER_URL =
  process.env.DOPPLER_INDEXER_URL ||
  (CHAIN_ID === 8453 ? "https://bankr.indexer.doppler.lol" : "https://testnet-indexer.doppler.lol");

/**
 * Fetch top fee earners by totalFeesUsd from the indexer.
 * Tries: (1) cumulatedFees as list with orderBy/limit, (2) cumulatedFees.items if schema uses Ponder-style.
 * @param {number} [limit=10]
 * @returns {Promise<Array<{ wallet: string, totalUsd: number, weth: number, token1Fees: string|null }>>}
 */
export async function fetchTopFeeEarners(limit = 10) {
  const cap = Math.min(Math.max(1, parseInt(limit, 10) || 10), 50);
  const base = DOPPLER_INDEXER_URL.replace(/\/$/, "");

  // Shape 1: root-level list (orderBy / orderDirection / limit on collection)
  const queryList = `
    query TopFeeRecipients($limit: Int!) {
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
    }
  `;

  // Shape 2: Ponder-style with items
  const queryItems = `
    query TopFeeRecipientsItems($limit: Int!) {
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
    }
  `;

  for (const query of [queryList, queryItems]) {
    try {
      const res = await fetch(`${base}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { limit: cap } }),
      });
      if (!res.ok) continue;
      const json = await res.json();
      if (json.errors?.length) continue;

      let list = json.data?.cumulatedFees;
      if (list && Array.isArray(list)) {
        // direct array
      } else if (list?.items && Array.isArray(list.items)) {
        list = list.items;
      } else {
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
      return Array.from(byWallet.values())
        .sort((a, b) => b.totalUsd - a.totalUsd)
        .slice(0, cap);
    } catch (_) {
      /* try next shape */
    }
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
  return null;
}
