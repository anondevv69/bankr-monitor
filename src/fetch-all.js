#!/usr/bin/env node
/**
 * Combined fetcher: tries Doppler indexer first, falls back to chain indexing.
 * Outputs JSON for piping to jq or other tools.
 */

import { fetchRecentLaunches } from "./fetch-from-chain.js";

const DOPPLER_INDEXER_URL =
  process.env.DOPPLER_INDEXER_URL || "https://testnet-indexer.doppler.lol";
const CHAIN_ID = parseInt(process.env.CHAIN_ID || "8453", 10);
const OUTPUT_JSON = process.env.OUTPUT_JSON === "1";

async function fetchFromIndexer() {
  const query = `
    query Tokens($chainId: Int!) {
      tokens(
        where: { chainId: $chainId }
        orderBy: "firstSeenAt"
        orderDirection: "desc"
        limit: 100
      ) {
        items {
          address
          chainId
          name
          symbol
          decimals
          image
          creatorAddress
          tokenUriData
          pool { address }
          volumeUsd
          holderCount
        }
      }
    }
  `;
  const res = await fetch(
    `${DOPPLER_INDEXER_URL.replace(/\/$/, "")}/graphql`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { chainId: CHAIN_ID },
      }),
    }
  );
  if (!res.ok) return null;
  const json = await res.json();
  if (json.errors) return null;
  return json.data?.tokens?.items ?? [];
}

function formatLaunch(t) {
  const links =
    t.tokenUriData && typeof t.tokenUriData === "object"
      ? {
          x: t.tokenUriData.x || t.tokenUriData.twitter || null,
          website:
            t.tokenUriData.websiteUrl ||
            t.tokenUriData.website ||
            t.tokenUriData.content?.uri ||
            null,
        }
      : { x: null, website: null };
  return {
    name: t.name,
    symbol: t.symbol,
    tokenAddress: t.address,
    launcher: t.creatorAddress || null,
    beneficiaries: t.pool?.beneficiaries ?? null,
    image: t.image || null,
    pool: t.pool?.address ?? t.pool ?? null,
    volumeUsd: t.volumeUsd != null ? String(t.volumeUsd) : null,
    holderCount: t.holderCount ?? null,
    ...links,
  };
}

async function main() {
  let launches = [];

  console.error("Trying Doppler Indexer...");
  const tokens = await fetchFromIndexer();
  if (tokens?.length > 0) {
    console.error(`Indexer: found ${tokens.length} tokens`);
    launches = tokens.map(formatLaunch);
  } else {
    console.error("Indexer failed or empty, trying chain...");
    let chainLaunches;
    try {
      chainLaunches = await fetchRecentLaunches(30000);
    } catch (e) {
      console.error("Chain fetch failed (set RPC_URL_BASE):", e.message);
      process.exit(1);
    }
    launches = chainLaunches.map((l) => ({
      name: l.name,
      symbol: l.symbol,
      tokenAddress: l.tokenAddress,
      launcher: null,
      image: null,
      pool: l.poolId,
      volumeUsd: null,
      holderCount: null,
      x: l.x || null,
      website: l.website || null,
    }));
  }

  if (OUTPUT_JSON) {
    console.log(JSON.stringify(launches, null, 2));
  } else {
    console.log(JSON.stringify(launches));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
