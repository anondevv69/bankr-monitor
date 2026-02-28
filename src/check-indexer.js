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

  // 1. Health (/ready is optional; many indexers don't expose it)
  try {
    const r = await fetch(`${base}/ready`);
    const ok = r.ok;
    console.log(`  /ready: ${ok ? "OK" : r.status} (optional — BankrMonitor uses /graphql only)`);
    if (!ok && r.status !== 404) {
      const t = await r.text();
      if (t) console.log(`    ${t.slice(0, 200)}`);
    }
  } catch (e) {
    console.log(`  /ready: ${e.message} (optional)`);
  }

  // 2. GraphQL — this is what BankrMonitor uses for tokens, v4pools, cumulatedFees
  let graphqlOk = false;
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
    const hasData = json?.data?.tokens !== undefined; // items can be []
    graphqlOk = ok && !json?.errors?.length;
    console.log(`  /graphql: ${graphqlOk ? "OK" : !ok ? r.status : "error"}`);
    if (r.status === 502) console.log(`    502 = indexer app may be down or still starting. Check Railway deploy logs and PORT.`);
    if (json?.errors?.length) console.log(`    errors: ${JSON.stringify(json.errors).slice(0, 200)}`);
  } catch (e) {
    console.log(`  /graphql: FAIL — ${e.message}`);
  }

  console.log("\n" + (graphqlOk ? "Indexer is usable. Set DOPPLER_INDEXER_URL in .env (no trailing slash)." : "Fix indexer so /graphql returns 200; then set DOPPLER_INDEXER_URL in .env."));
}

check().catch((e) => {
  console.error(e);
  process.exit(1);
});
