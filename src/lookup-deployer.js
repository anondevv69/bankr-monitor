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
// How many launches to scan from full list (with API key) to find all tokens for a wallet. Higher = more pages/faster for big deployers.
const BANKR_LAUNCHES_LIMIT = parseInt(process.env.BANKR_LAUNCHES_LIMIT || "50000", 10);
// When handle not found in newest launches, fetch this many oldest (order=asc) to resolve X/FC -> wallet
const OLDEST_FETCH_LIMIT = Math.min(parseInt(process.env.BANKR_OLDEST_FETCH_LIMIT || "10000", 10), 50000);
const SEARCH_API = "https://api.bankr.bot/token-launches/search";
const DEPLOY_API = "https://api.bankr.bot/token-launches/deploy";
const SEARCH_PAGE_SIZE = Math.min(Math.max(parseInt(process.env.BANKR_SEARCH_PAGE_SIZE || "25", 10), 5), 50);

/** Optional handle -> wallet overrides (e.g. BANKR_HANDLE_WALLET_OVERRIDES='{"gork":"0x23..."}') when API doesn't return them. */
function getHandleOverrides() {
  const raw = process.env.BANKR_HANDLE_WALLET_OVERRIDES;
  if (!raw || typeof raw !== "string") return new Map();
  const map = new Map();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        const h = norm(String(k).replace(/^@/, ""));
        if (h && v && /^0x[a-fA-F0-9]{40}$/.test(String(v).trim())) map.set(h, String(v).trim().toLowerCase());
      }
    }
  } catch {
    // Fallback: "gork:0x23...,other:0x..."
    for (const part of raw.split(",")) {
      const idx = part.indexOf(":");
      if (idx <= 0) continue;
      const h = norm(part.slice(0, idx).trim().replace(/^@/, ""));
      const w = part.slice(idx + 1).trim();
      if (h && w && /^0x[a-fA-F0-9]{40}$/.test(w)) map.set(h, w.toLowerCase());
    }
  }
  return map;
}

function norm(s) {
  if (!s || typeof s !== "string") return null;
  const t = s.trim().toLowerCase();
  return t || null;
}

function isWallet(s) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(s).trim());
}

/** Fetch from Bankr search API (same as bankr.bot/launches/search).
 * Returns { launches, totalCount } or null on failure.
 * Note: API often returns at most 5 results per group and may ignore offset; totalCount can still be correct (e.g. 10). */
async function fetchSearch(query) {
  const q = encodeURIComponent(String(query).trim());
  if (!q) return null;
  const seen = new Set();
  const out = [];
  let offset = 0;
  const pageSize = SEARCH_PAGE_SIZE;
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
      offset += Math.max(byDeployer.length, byFee.length, 1);
      if (byDeployer.length === 0 && byFee.length === 0) break;
    }
    return out.length ? { launches: out, totalCount: totalCount || out.length } : null;
  } catch {
    return null;
  }
}

/** Fetch one page of launches from Bankr API. order: undefined (default/newest) or "asc" for oldest first. */
async function fetchLaunchesPage(offset, pageSize = 50, order) {
  let url = `https://api.bankr.bot/token-launches?limit=${pageSize}&offset=${offset}`;
  if (order === "asc") url += "&order=asc";
  const res = await fetch(url, {
    headers: { "X-API-Key": BANKR_API_KEY, Accept: "application/json" },
  });
  if (!res.ok) return [];
  const json = await res.json();
  return json.launches?.filter((l) => l.status === "deployed") ?? [];
}

const FULL_LIST_CONCURRENCY = Math.min(parseInt(process.env.BANKR_FULL_LIST_CONCURRENCY || "10", 10), 20);

/** Fetch launches from Bankr API (paginated, parallel). order: undefined (newest first) or "asc" (oldest first). */
async function fetchAllLaunches(limit = BANKR_LAUNCHES_LIMIT, order) {
  if (!BANKR_API_KEY) return [];
  const out = [];
  const seen = new Set();
  const pageSize = 50;
  let offset = 0;

  while (offset < limit) {
    const batchOffsets = [];
    for (let i = 0; i < FULL_LIST_CONCURRENCY; i++) {
      const o = offset + i * pageSize;
      if (o >= limit) break;
      batchOffsets.push(o);
    }
    if (batchOffsets.length === 0) break;
    const batches = await Promise.all(batchOffsets.map((o) => fetchLaunchesPage(o, pageSize, order)));
    let hasLessThanFull = false;
    for (const batch of batches) {
      if (batch.length < pageSize) hasLessThanFull = true;
      for (const l of batch) {
        const key = l.tokenAddress?.toLowerCase();
        if (key && !seen.has(key)) {
          seen.add(key);
          out.push(l);
        }
      }
    }
    if (hasLessThanFull || batches.some((b) => b.length === 0)) break;
    offset += batchOffsets.length * pageSize;
  }
  return out;
}

/** Build map of normalized X/FC handle -> wallet from launches (so we can resolve "gork" -> wallet and search by wallet). */
function buildHandleToWalletMap(launches) {
  const map = new Map();
  for (const l of launches) {
    const d = l.deployer;
    const f = l.feeRecipient;
    const add = (handle, wallet) => {
      if (!handle || !wallet) return;
      const h = norm(String(handle).replace(/^@/, ""));
      if (h) map.set(h, (map.get(h) || wallet).toLowerCase());
    };
    const xFrom = (obj) => obj?.xUsername ?? obj?.twitter ?? obj?.x ?? obj?.socials?.twitter ?? obj?.socials?.x;
    const fcFrom = (obj) => obj?.farcasterUsername ?? obj?.farcaster ?? obj?.fcUsername ?? obj?.fc;
    if (d?.walletAddress) {
      if (xFrom(d)) add(xFrom(d), d.walletAddress);
      const fc = fcFrom(d);
      if (fc) add(fc, d.walletAddress);
    }
    if (f?.walletAddress) {
      if (xFrom(f)) add(xFrom(f), f.walletAddress);
      const fc = fcFrom(f);
      if (fc) add(fc, f.walletAddress);
    }
  }
  return map;
}

/** Check if a launch matches the query. filter: "deployer" | "fee" | "both". */
function launchMatches(launch, queryNorm, isWalletQuery, filter = "both") {
  const deployer = launch.deployer;
  const fee = launch.feeRecipient;

  const matchDeployer = () => {
    if (isWalletQuery) return deployer?.walletAddress?.toLowerCase() === queryNorm;
    const q = queryNorm;
    const deployerX = deployer?.xUsername ? norm(String(deployer.xUsername).replace(/^@/, "")) : null;
    const deployerFc = norm(deployer?.farcasterUsername ?? deployer?.farcaster ?? deployer?.fcUsername ?? "");
    return deployerX === q || deployerFc === q;
  };
  const matchFee = () => {
    if (isWalletQuery) return fee?.walletAddress?.toLowerCase() === queryNorm;
    const q = queryNorm;
    const feeX = fee?.xUsername ? norm(String(fee.xUsername).replace(/^@/, "")) : null;
    const feeFc = norm(fee?.farcasterUsername ?? fee?.farcaster ?? fee?.fcUsername ?? "");
    return (feeX && feeX === q) || (feeFc && feeFc === q);
  };

  if (filter === "deployer") return matchDeployer();
  if (filter === "fee") return matchFee();
  return matchDeployer() || matchFee();
}

/** Extract username from X/Twitter or Farcaster URL; otherwise return null. */
function extractFromUrl(raw) {
  const s = String(raw).trim();
  // x.com/username, .../username/with_replies, .../username/status/123456 — first path segment = handle
  const xMatch = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com)\/([a-zA-Z0-9_]+)(?:\/|$|\?)/i);
  if (xMatch) return { normalized: xMatch[1].toLowerCase(), isWallet: false };
  // warpcast.com/~/username, farcaster.xyz/username, farcaster.xyz/username/0x... — first path segment = handle
  const fcMatch = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:warpcast\.com\/~\/|warpcast\.com\/|farcaster\.xyz\/)([a-zA-Z0-9_.-]+)(?:\/|$|\?)/i);
  if (fcMatch) return { normalized: fcMatch[1].toLowerCase(), isWallet: false };
  return null;
}

/** Resolve query to normalized form and whether it's a wallet. Accepts wallet, @username, x(username), F(username), or X/Farcaster profile URL. */
function parseQuery(query) {
  const raw = String(query).trim();
  if (!raw) return { normalized: null, isWallet: false };
  const fromUrl = extractFromUrl(raw);
  if (fromUrl) return fromUrl;
  if (isWallet(raw)) return { normalized: raw.toLowerCase(), isWallet: true };
  // @username, x(username), F(username) -> username
  const normalized = raw.replace(/^@/, "").replace(/^[xX]\(([^)]+)\)$/, "$1").replace(/^[fF]\(([^)]+)\)$/, "$1").trim().toLowerCase();
  return { normalized: normalized || null, isWallet: false };
}

/**
 * Resolve an X or Farcaster handle (or URL) to a wallet address using Bankr launch data.
 * Requires BANKR_API_KEY. Returns the wallet if we have it in our launch list; otherwise null.
 * @returns { Promise<{ wallet: string | null, normalized: string | null, isWallet: boolean }> }
 */
export async function resolveHandleToWallet(query) {
  const { normalized, isWallet } = parseQuery(query);
  if (!normalized) return { wallet: null, normalized: null, isWallet: false };
  if (isWallet) return { wallet: normalized, normalized, isWallet: true };
  const overrides = getHandleOverrides();
  const overrideWallet = overrides.get(normalized);
  if (overrideWallet) return { wallet: overrideWallet, normalized, isWallet: false };
  if (!BANKR_API_KEY) return { wallet: null, normalized, isWallet: false };
  const all = await fetchAllLaunches();
  let handleToWallet = buildHandleToWalletMap(all);
  let wallet = handleToWallet.get(normalized) ?? null;
  if (!wallet && OLDEST_FETCH_LIMIT > 0) {
    const oldest = await fetchAllLaunches(OLDEST_FETCH_LIMIT, "asc");
    const mapOld = buildHandleToWalletMap(oldest);
    for (const [h, w] of mapOld) if (!handleToWallet.has(h)) handleToWallet.set(h, w);
    wallet = handleToWallet.get(normalized) ?? null;
  }
  // Last resort: Bankr resolves handle→wallet when we deploy; same resolution is not exposed as a read API.
  // We can call the deploy endpoint with simulateOnly: true and feeRecipient { type: "x"|"farcaster", value } to get the resolved wallet from feeDistribution.creator.
  if (!wallet) {
    const resolved = await resolveHandleViaDeploySimulate(normalized);
    if (resolved) wallet = resolved;
  }
  return { wallet, normalized, isWallet: false };
}

/**
 * Resolve a handle to wallet by calling Bankr deploy API with simulateOnly: true.
 * Bankr resolves fee recipient (x/farcaster) server-side; the response includes feeDistribution.creator with the resolved address.
 * Requires BANKR_API_KEY with Agent API (write) access. Returns null if resolution fails or key missing.
 * @param {string} handle - Normalized handle (no @).
 * @returns {Promise<string | null>} Resolved wallet (lowercase) or null.
 */
async function resolveHandleViaDeploySimulate(handle) {
  if (!BANKR_API_KEY || !handle) return null;
  const typesToTry = /\.(eth|lens)$/.test(handle) ? ["ens", "farcaster", "x"] : ["x", "farcaster", "ens"];
  for (const type of typesToTry) {
    try {
      const res = await fetch(DEPLOY_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": BANKR_API_KEY.trim() },
        body: JSON.stringify({
          tokenName: "ResolveCheck",
          simulateOnly: true,
          feeRecipient: { type, value: handle },
        }),
      });
      if (res.status === 401 || res.status === 403) return null;
      if (!res.ok) continue;
      const data = await res.json().catch(() => ({}));
      const creator = data?.feeDistribution?.creator;
      const addr =
        creator?.address ??
        creator?.wallet ??
        creator?.walletAddress ??
        (typeof creator === "string" ? creator : null);
      if (addr && /^0x[a-fA-F0-9]{40}$/.test(String(addr).trim())) return String(addr).trim().toLowerCase();
    } catch {
      // ignore and try next type
    }
  }
  return null;
}

/** @param filter "deployer" | "fee" | "both" - limit to tokens where query matches deployer, fee recipient, or either
 *  @param sortOrder "newest" | "oldest" - newest first (default) or oldest first */
export async function lookupByDeployerOrFee(query, filter = "both", sortOrder = "newest") {
  const { normalized, isWallet: isWalletQuery } = parseQuery(query);
  if (!normalized) return { matches: [], totalCount: 0, query: query };

  const matches = (l) => launchMatches(l, normalized, isWalletQuery, filter);
  let launches = [];
  let totalCount = 0;
  let resolvedWallet = null;
  // Search using normalized form (username or wallet) so URLs like https://x.com/ayowtfchil become "ayowtfchil"
  let searchResult = await fetchSearch(normalized);
  // If handle (no wallet), also try @ prefix — Bankr search may index X as "@gork"; try when no results or after filter we'd have 0
  if (!isWalletQuery && normalized && !normalized.startsWith("@")) {
    const filteredFromFirst = searchResult ? searchResult.launches.filter(matches) : [];
    if (filteredFromFirst.length === 0) {
      const withAt = await fetchSearch("@" + normalized);
      if (withAt && withAt.launches.length > 0) {
        searchResult = searchResult
          ? { launches: [...new Map([...searchResult.launches, ...withAt.launches].map((l) => [l.tokenAddress?.toLowerCase(), l])).values()], totalCount: Math.max(searchResult.totalCount, withAt.totalCount) }
          : withAt;
      }
    }
  }
  if (searchResult) {
    launches = searchResult.launches.filter(matches);
    totalCount = searchResult.totalCount;
  }
  // Search API often caps at 5 results; with API key fetch full list and merge so we return all matches
  if (BANKR_API_KEY) {
    let all = await fetchAllLaunches();
    let handleToWallet = buildHandleToWalletMap(all);
    for (const [h, w] of getHandleOverrides()) handleToWallet.set(h, w);
    if (!handleToWallet.has(normalized) && OLDEST_FETCH_LIMIT > 0) {
      const oldest = await fetchAllLaunches(OLDEST_FETCH_LIMIT, "asc");
      const mapOld = buildHandleToWalletMap(oldest);
      for (const [h, w] of mapOld) if (!handleToWallet.has(h)) handleToWallet.set(h, w);
      const seenAddr = new Set(all.map((l) => l.tokenAddress?.toLowerCase()).filter(Boolean));
      all = [...all, ...oldest.filter((l) => {
        const k = l.tokenAddress?.toLowerCase();
        if (!k || seenAddr.has(k)) return false;
        seenAddr.add(k);
        return true;
      })];
    }
    const matched = all.filter(matches);
    const seen = new Set(launches.map((l) => l.tokenAddress?.toLowerCase()).filter(Boolean));
    for (const l of matched) {
      const key = l.tokenAddress?.toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        launches.push(l);
      }
    }
    totalCount = Math.max(launches.length, totalCount);
    // Resolve X/FC handle -> wallet (from list, overrides, or deploy-simulate), then search by that wallet so we get all tokens
    if (!isWalletQuery && normalized) {
      let wallet = handleToWallet.get(normalized) ?? null;
      if (!wallet) {
        const resolved = await resolveHandleToWallet(query);
        wallet = resolved.wallet ?? null;
      }
      if (wallet) {
        resolvedWallet = wallet;
        const byWallet = await fetchSearch(wallet);
        if (byWallet && byWallet.launches.length > 0) {
          const walletMatchesFn = (l) => launchMatches(l, wallet, true, filter);
          const fromWallet = byWallet.launches.filter(walletMatchesFn);
          const seenAddr = new Set(launches.map((l) => l.tokenAddress?.toLowerCase()).filter(Boolean));
          for (const l of fromWallet) {
            const key = l.tokenAddress?.toLowerCase();
            if (key && !seenAddr.has(key)) {
              seenAddr.add(key);
              launches.push(l);
            }
          }
          totalCount = Math.max(byWallet.totalCount ?? totalCount, launches.length);
        }
      }
    }
  }
  if (totalCount === 0 && launches.length > 0) totalCount = launches.length;

  const possiblyCapped = launches.length === SEARCH_PAGE_SIZE && totalCount === SEARCH_PAGE_SIZE;

  const result = launches.map((l) => {
    const deployedAt =
      l.deployedAt ?? l.createdAt ?? l.completedAt ?? l.deployed_at ?? l.created_at ?? l.completed_at ?? l.timestamp ?? l.blockTimestamp;
    const sortTime = deployedAt ? new Date(deployedAt).getTime() : 0;
    return {
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
      deployedAt: deployedAt || null,
      sortTime,
    };
  });

  // Sort by deploy time when we have dates; otherwise keep API order
  const hasDates = result.some((m) => m.sortTime > 0);
  if (hasDates) {
    result.sort((a, b) => (sortOrder === "oldest" ? a.sortTime - b.sortTime : b.sortTime - a.sortTime));
  }

  return {
    query,
    normalized,
    totalCount,
    possiblyCapped,
    hasDates,
    resolvedWallet: resolvedWallet ?? null,
    matches: result,
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

  const { matches, totalCount, normalized, resolvedWallet } = await lookupByDeployerOrFee(query);
  console.log(`Query: ${query} (normalized: ${normalized})`);
  if (resolvedWallet) console.log(`Resolved wallet: ${resolvedWallet}`);
  console.log(`Total: ${totalCount} token(s)`);
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
