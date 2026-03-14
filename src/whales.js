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
