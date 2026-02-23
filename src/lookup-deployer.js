#!/usr/bin/env node
/**
 * Look up Bankr token launches by deployer or fee recipient: wallet, X handle, or Farcaster handle.
 * Uses Bankr search API (same as bankr.bot/launches/search) when possible; falls back to paginated list + filter.
 *
 * Usage: node src/lookup-deployer.js <wallet|@xhandle|farcaster>
 * Example: node src/lookup-deployer.js 0x62Bcefd446f97526ECC1375D02e014cFb8b48BA3
 *          node src/lookup-deployer.js @vyrozas
 *          node src/lookup-deployer.js dwr.eth
 *
 * Env: BANKR_API_KEY (required for fallback; search may work without it).
 */

import "dotenv/config";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BANKR_API_KEY = process.env.BANKR_API_KEY;
const BANKR_LAUNCHES_LIMIT = parseInt(process.env.BANKR_LAUNCHES_LIMIT || "500", 10);
const SEARCH_API = "https://api.bankr.bot/token-launches/search";

function norm(s) {
  if (!s || typeof s !== "string") return null;
  const t = s.trim().toLowerCase();
  return t || null;
}

function isWallet(s) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(s).trim());
}

/** Fetch from Bankr search API (same as bankr.bot/launches/search). Returns raw launch objects or null on failure. */
async function fetchSearch(query) {
  const q = encodeURIComponent(String(query).trim());
  if (!q) return null;
  const seen = new Set();
  const out = [];
  let offset = 0;
  const pageSize = 10;
  let totalCount = 0;

  try {
    while (true) {
      const url = `${SEARCH_API}?q=${q}&limit=${pageSize}&offset=${offset}`;
      const res = await fetch(url, {
        headers: { Accept: "application/json", ...(BANKR_API_KEY && { "X-API-Key": BANKR_API_KEY }) },
      });
      if (!res.ok) break;
      const json = await res.json();
      const byDeployer = json.groups?.byDeployer?.results ?? [];
      const byFee = json.groups?.byFeeRecipient?.results ?? [];
      const total = json.groups?.byDeployer?.totalCount ?? json.groups?.byFeeRecipient?.totalCount ?? 0;
      if (total > totalCount) totalCount = total;

      let added = 0;
      for (const l of [...byDeployer, ...byFee]) {
        if (l.status !== "deployed") continue;
        const key = l.tokenAddress?.toLowerCase();
        if (key && !seen.has(key)) {
          seen.add(key);
          out.push(l);
          added++;
        }
      }
      if (added === 0 || (totalCount > 0 && out.length >= totalCount)) break;
      offset += pageSize;
      if (byDeployer.length < pageSize && byFee.length < pageSize) break;
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/** Fetch launches from Bankr API (paginated). Returns raw launch objects. */
async function fetchAllLaunches() {
  if (!BANKR_API_KEY) return [];
  const out = [];
  const seen = new Set();
  const pageSize = 50;
  let offset = 0;

  while (offset < BANKR_LAUNCHES_LIMIT) {
    const url = `https://api.bankr.bot/token-launches?limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { "X-API-Key": BANKR_API_KEY, Accept: "application/json" },
    });
    if (!res.ok) {
      console.error(`[Bankr API] ${res.status} ${res.statusText}`);
      break;
    }
    const json = await res.json();
    const batch = json.launches?.filter((l) => l.status === "deployed") ?? [];
    if (batch.length === 0) break;

    for (const l of batch) {
      const key = l.tokenAddress?.toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        out.push(l);
      }
    }
    if (batch.length < pageSize) break;
    offset += batch.length;
  }
  return out;
}

/** Check if a launch matches the query (deployer or fee recipient: wallet, X, or Farcaster). */
function launchMatches(launch, queryNorm, isWalletQuery) {
  const deployer = launch.deployer;
  const fee = launch.feeRecipient;

  if (isWalletQuery) {
    const dw = deployer?.walletAddress?.toLowerCase();
    const fw = fee?.walletAddress?.toLowerCase();
    if (dw === queryNorm || fw === queryNorm) return true;
    return false;
  }

  const q = queryNorm;
  const deployerX = deployer?.xUsername ? norm(String(deployer.xUsername).replace(/^@/, "")) : null;
  const deployerFc = norm(deployer?.farcasterUsername ?? deployer?.farcaster ?? deployer?.fcUsername ?? "");
  const feeX = fee?.xUsername ? norm(String(fee.xUsername).replace(/^@/, "")) : null;
  const feeFc = norm(fee?.farcasterUsername ?? fee?.farcaster ?? fee?.fcUsername ?? "");

  return (
    deployerX === q ||
    deployerFc === q ||
    (feeX && feeX === q) ||
    (feeFc && feeFc === q)
  );
}

/** Resolve query to normalized form and whether it's a wallet. */
function parseQuery(query) {
  const raw = String(query).trim();
  const normalized = raw.startsWith("0x") ? raw.toLowerCase() : raw.replace(/^@/, "").toLowerCase();
  return { normalized, isWallet: isWallet(raw) };
}

export async function lookupByDeployerOrFee(query) {
  const { normalized, isWallet: isWalletQuery } = parseQuery(query);
  if (!normalized) return { matches: [], query: query };

  let launches = await fetchSearch(query);
  if (!launches || launches.length === 0) {
    launches = await fetchAllLaunches();
    launches = launches.filter((l) => launchMatches(l, normalized, isWalletQuery));
  } else {
    launches = launches.filter((l) => launchMatches(l, normalized, isWalletQuery));
  }

  return {
    query,
    normalized,
    matches: launches.map((l) => ({
      tokenAddress: l.tokenAddress,
      tokenName: l.tokenName ?? "—",
      tokenSymbol: l.tokenSymbol ?? "—",
      deployerWallet: l.deployer?.walletAddress ?? null,
      deployerX: l.deployer?.xUsername ?? null,
      deployerFc: l.deployer?.farcasterUsername ?? l.deployer?.farcaster ?? l.deployer?.fcUsername ?? null,
      feeRecipientWallet: l.feeRecipient?.walletAddress ?? null,
      feeRecipientX: l.feeRecipient?.xUsername ?? null,
      feeRecipientFc: l.feeRecipient?.farcasterUsername ?? l.feeRecipient?.fcUsername ?? null,
      bankrUrl: `https://bankr.bot/launches/${l.tokenAddress}`,
    })),
  };
}

async function main() {
  const query = process.argv[2];
  if (!query) {
    console.log("Usage: node src/lookup-deployer.js <wallet|@xhandle|farcaster>");
    console.log("Example: node src/lookup-deployer.js 0x62Bc...");
    console.log("         node src/lookup-deployer.js @vyrozas");
    console.log("         node src/lookup-deployer.js dwr.eth");
    process.exit(1);
  }

  const { matches, normalized } = await lookupByDeployerOrFee(query);
  console.log(`Query: ${query} (normalized: ${normalized})`);
  console.log(`Matches: ${matches.length} token(s)\n`);
  if (matches.length > 0) {
    console.log(`Full list on site: https://bankr.bot/launches/search?q=${encodeURIComponent(String(query).trim())}\n`);
  }

  if (matches.length === 0) {
    console.log("No Bankr tokens found for this wallet, X handle, or Farcaster handle.");
    console.log("Try bankr.bot/launches/search?q=<your-query> or set BANKR_API_KEY in .env for fallback search.");
    return;
  }

  for (const m of matches) {
    console.log(`${m.tokenName} ($${m.tokenSymbol})`);
    console.log(`  CA: ${m.tokenAddress}`);
    console.log(`  Bankr: ${m.bankrUrl}`);
    if (m.deployerWallet || m.deployerX || m.deployerFc) {
      console.log(`  Deployer: ${m.deployerWallet ?? ""} ${m.deployerX ? `X: @${m.deployerX}` : ""} ${m.deployerFc ? `FC: ${m.deployerFc}` : ""}`);
    }
    if (m.feeRecipientWallet || m.feeRecipientX || m.feeRecipientFc) {
      console.log(`  Fee recipient: ${m.feeRecipientWallet ?? ""} ${m.feeRecipientX ? `X: @${m.feeRecipientX}` : ""} ${m.feeRecipientFc ? `FC: ${m.feeRecipientFc}` : ""}`);
    }
    console.log("");
  }
}

const isRunDirectly = process.argv[1]?.includes("lookup-deployer");
if (isRunDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
