#!/usr/bin/env node
/**
 * Fetch tokens from Doppler Indexer GraphQL API.
 * Bankr tokens on Base are created via Doppler protocol and indexed here.
 *
 * Indexer URLs:
 * - Testnet (Base Sepolia): https://testnet-indexer.doppler.lol
 * - Production (Base): https://indexer.doppler.lol (check availability)
 */

const DOPPLER_INDEXER_URL =
  process.env.DOPPLER_INDEXER_URL || "https://testnet-indexer.doppler.lol";
const CHAIN_ID = parseInt(process.env.CHAIN_ID || "8453", 10); // 8453 = Base, 84532 = Base Sepolia

async function graphql(query, variables = {}) {
  const res = await fetch(`${DOPPLER_INDEXER_URL.replace(/\/$/, "")}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Indexer HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

/**
 * Fetch tokens from Doppler indexer.
 * Token schema: address, chainId, name, symbol, image, creatorAddress, tokenUriData, pool
 * @see https://github.com/whetstoneresearch/doppler-indexer
 */
async function fetchTokens(limit = 100) {
  const query = `
    query Tokens($chainId: Int!, $limit: Int!) {
      tokens(
        where: { chainId: $chainId }
        orderBy: "firstSeenAt"
        orderDirection: "desc"
        limit: $limit
      ) {
        items {
          address
          chainId
          name
          symbol
          decimals
          image
          totalSupply
          creatorAddress
          tokenUriData
          pool { address, beneficiaries }
          volumeUsd
          holderCount
        }
      }
    }
  `;
  const data = await graphql(query, { chainId: CHAIN_ID, limit });
  return data?.tokens?.items ?? [];
}

/**
 * Fetch V4 pools (Bankr uses V4 multicurve on Base).
 */
async function fetchV4Pools(limit = 100) {
  const query = `
    query V4Pools($chainId: Int!, $limit: Int!) {
      v4pools(
        where: { chainId: $chainId }
        orderBy: "createdAt"
        orderDirection: "desc"
        limit: $limit
      ) {
        items {
          id
          poolId
          chainId
          baseToken
          quoteToken
          asset
          price
          dollarLiquidity
          volumeUsd
          beneficiaries
          migratedFromPool
        }
      }
    }
  `;
  const data = await graphql(query, { chainId: CHAIN_ID, limit });
  return data?.v4pools?.items ?? [];
}

function extractSocialLinks(tokenUriData) {
  if (!tokenUriData || typeof tokenUriData !== "object") return {};
  const d = tokenUriData;
  return {
    x: d.x || d.twitter || null,
    website: d.websiteUrl || d.website || d.content?.uri || null,
  };
}

async function main() {
  console.log(`Fetching from Doppler Indexer: ${DOPPLER_INDEXER_URL}`);
  console.log(`Chain ID: ${CHAIN_ID}\n`);

  try {
    // Try tokens first (most reliable)
    let tokens = await fetchTokens(50);
    if (tokens.length === 0) {
      try {
        const v4 = await fetchV4Pools(50);
        tokens = (v4 || []).map((p) => ({
          address: p.baseToken,
          name: null,
          symbol: null,
          image: null,
          creatorAddress: null,
          tokenUriData: null,
          pool: p.poolId,
          dollarLiquidity: p.dollarLiquidity,
          volumeUsd: p.volumeUsd,
          beneficiaries: p.beneficiaries,
        }));
      } catch (_) {}
    }

    console.log(`Found ${tokens.length} tokens\n`);

    for (const t of tokens) {
      const links = extractSocialLinks(t.tokenUriData);
      console.log("---");
      console.log(`Token: ${t.name} ($${t.symbol})`);
      console.log(`  CA: ${t.address}`);
      console.log(`  Launcher: ${t.creatorAddress || "—"}`);
      console.log(`  Image: ${t.image || "(none)"}`);
      if (links.x) console.log(`  X: ${links.x}`);
      if (links.website) console.log(`  Website: ${links.website}`);
      const poolAddr = t.pool?.address ?? t.pool;
      if (poolAddr) console.log(`  Pool: ${poolAddr}`);
      if (t.pool?.beneficiaries) console.log(`  Beneficiaries: ${JSON.stringify(t.pool.beneficiaries)}`);
      if (t.dollarLiquidity != null) console.log(`  Liquidity: $${t.dollarLiquidity}`);
      if (t.volumeUsd != null) console.log(`  Volume: $${t.volumeUsd}`);
      if (t.beneficiaries) console.log(`  Fee recipients: ${JSON.stringify(t.beneficiaries)}`);
    }
  } catch (err) {
    console.error("Fetch failed:", err.message);
    process.exit(1);
  }
}

main();
