#!/usr/bin/env node
/**
 * Check if the Doppler indexer is reachable and responding.
 * Usage: node src/check-indexer.js [INDEXER_URL]
 * Env: DOPPLER_INDEXER_URL (default from .env or testnet indexer)
 */

import "dotenv/config";

const base = (process.env.DOPPLER_INDEXER_URL || process.argv[2] || "https://testnet-indexer.doppler.lol")
  .replace(/\/$/, "");

async function check() {
  console.log(`Checking indexer: ${base}\n`);

  // 1. Health
  try {
    const r = await fetch(`${base}/ready`);
    const ok = r.ok;
    console.log(`  /ready: ${ok ? "OK" : r.status}`);
    if (!ok && r.status !== 404) {
      const t = await r.text();
      if (t) console.log(`    ${t.slice(0, 200)}`);
    }
  } catch (e) {
    console.log(`  /ready: FAIL — ${e.message}`);
  }

  // 2. GraphQL
  try {
    const r = await fetch(`${base}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query { tokens(where: { chainId: 8453 }, limit: 1) { items { address } } }`,
        variables: {},
      }),
    });
    const ok = r.ok;
    const json = await r.json().catch(() => ({}));
    const hasData = json?.data?.tokens?.items?.length >= 0;
    console.log(`  /graphql: ${ok && hasData ? "OK" : !ok ? r.status : "no data"}`);
    if (json?.errors?.length) console.log(`    errors: ${JSON.stringify(json.errors).slice(0, 150)}`);
  } catch (e) {
    console.log(`  /graphql: FAIL — ${e.message}`);
  }

  console.log("\nIf both show OK, the indexer is working. Use DOPPLER_INDEXER_URL in .env to point token-stats/notify here.");
}

check().catch((e) => {
  console.error(e);
  process.exit(1);
});
