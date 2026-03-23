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
 * Env: BANKR_API_KEY (Telegram multi-key: TELEGRAM_BANKR_API_KEYS only).
 */

import "dotenv/config";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { defaultBankrApiKey } from "./bankr-env-key.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// How many launches to scan from full list (with API key) to find all tokens for a wallet. Higher = more pages/faster for big deployers.
const BANKR_LAUNCHES_LIMIT = parseInt(process.env.BANKR_LAUNCHES_LIMIT || "50000", 10);
// Wallet-only lookups: fetch this many newest launches so /lookup by wallet is fast. Increase if tokens are missed.
const BANKR_WALLET_LOOKUP_LIMIT = Math.min(parseInt(process.env.BANKR_WALLET_LOOKUP_LIMIT || "10000", 10), 50000);
// When handle not found in newest launches, fetch this many oldest (order=asc) to resolve X/FC -> wallet
const OLDEST_FETCH_LIMIT = Math.min(parseInt(process.env.BANKR_OLDEST_FETCH_LIMIT || "10000", 10), 50000);
const SEARCH_API = "https://api.bankr.bot/token-launches/search";
const DEPLOY_API = "https://api.bankr.bot/token-launches/deploy";
const SEARCH_PAGE_SIZE = Math.min(Math.max(parseInt(process.env.BANKR_SEARCH_PAGE_SIZE || "25", 10), 5), 50);
/** Cache for getBankrWalletLaunchRoleCounts (ms). Default 5m. */
const BANKR_WALLET_ROLE_COUNT_TTL_MS = parseInt(process.env.BANKR_WALLET_ROLE_COUNT_TTL_MS || "300000", 10);
const bankrWalletRoleCountCache = new Map();

const BANKR_FETCH_HEADERS = {
  Accept: "application/json",
  "User-Agent": "BankrMonitor/1.0 (https://github.com/anondevv69/bankr-monitor)",
};

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

/** Parse search API response into arrays of launches + totalCount. Handles multiple response shapes.
 * Bankr search can return a single match in exactMatch when the query matches one launch (e.g. by wallet). */
function getSearchResultArrays(json) {
  const byDeployer = json.groups?.byDeployer?.results ?? [];
  const byFee = json.groups?.byFeeRecipient?.results ?? [];
  const byWallet = json.groups?.byWallet?.results ?? [];
  const exactMatch = json.exactMatch && json.exactMatch.status === "deployed" ? [json.exactMatch] : [];
  const flat =
    Array.isArray(json.results) ? json.results
      : Array.isArray(json.launches) ? json.launches
        : Array.isArray(json.data?.results) ? json.data.results
          : Array.isArray(json.data?.launches) ? json.data.launches
            : Array.isArray(json.hits) ? json.hits
              : Array.isArray(json.items) ? json.items
                : [];
  const total =
    json.groups?.byDeployer?.totalCount ??
    json.groups?.byFeeRecipient?.totalCount ??
    json.groups?.byWallet?.totalCount ??
    json.totalCount ??
    0;
  const arrays = [...exactMatch, ...byDeployer, ...byFee, ...byWallet, ...flat];
  return { arrays, total: total || (exactMatch.length > 0 ? 1 : 0) };
}

/** Merge toAdd into launches by tokenAddress (no duplicates). Mutates launches. */
function mergeLaunchesWithoutDuplicates(launches, toAdd) {
  const seen = new Set(launches.map((l) => l.tokenAddress?.toLowerCase()).filter(Boolean));
  for (const l of toAdd) {
    const key = l.tokenAddress?.toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      launches.push(l);
    }
  }
}

/** Fetch from Bankr search API (same as bankr.bot/launches/search).
 * Returns { launches, totalCount } or null on failure.
 * apiKey: optional override (e.g. tenant's key); else round-robin env keys.
 * Note: API often returns at most 5 results per group and may ignore offset; totalCount can still be correct (e.g. 10). */
async function fetchSearch(query, apiKey) {
  const key = defaultBankrApiKey(apiKey);
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
        headers: { ...BANKR_FETCH_HEADERS, ...(key && { "X-API-Key": key }) },
      });
      if (!res.ok) break;
      const json = await res.json();
      const { arrays, total } = getSearchResultArrays(json);
      if (arrays.length > 0 && offset === 0) {
        const fromExact = json.exactMatch && json.exactMatch.status === "deployed" ? 1 : 0;
        console.log(`[Lookup] Search API: ${arrays.length} item(s) (exactMatch: ${fromExact}, groups: ${arrays.length - fromExact})`);
      }
      if (total > totalCount) totalCount = total;

      let added = 0;
      for (const l of arrays) {
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
      if (arrays.length === 0) break;
    }
    return out.length ? { launches: out, totalCount: totalCount || out.length } : null;
  } catch {
    return null;
  }
}

/** Fetch one page of launches from Bankr API. order: undefined (default/newest) or "asc" for oldest first. apiKey: optional override. */
async function fetchLaunchesPage(offset, pageSize = 50, order, apiKey) {
  const key = defaultBankrApiKey(apiKey);
  if (!key) return [];
  let url = `https://api.bankr.bot/token-launches?limit=${pageSize}&offset=${offset}`;
  if (order === "asc") url += "&order=asc";
  const res = await fetch(url, {
    headers: { ...BANKR_FETCH_HEADERS, "X-API-Key": key, Accept: "application/json" },
  });
  if (!res.ok) return [];
  const json = await res.json();
  return json.launches?.filter((l) => l.status === "deployed") ?? [];
}

const FULL_LIST_CONCURRENCY = Math.min(parseInt(process.env.BANKR_FULL_LIST_CONCURRENCY || "10", 10), 20);

const LIST_CACHE_TTL_MS = 3 * 60 * 1000;
let _listCache = null;
let _listCacheKey = null;
let _listCacheTime = 0;

/** Stable fingerprint so Telegram vs Discord (different X-API-Key) never share one launch list cache. */
function bankrKeyFingerprint(apiKeyStr) {
  const k = apiKeyStr && String(apiKeyStr).trim();
  if (!k) return "none";
  let h = 0;
  for (let i = 0; i < k.length; i++) h = (Math.imul(31, h) + k.charCodeAt(i)) | 0;
  return `${k.length}:${(h >>> 0).toString(16)}`;
}

/** In-memory cache for list API to avoid hammering Bankr on every /lookup (Discord-safe). */
async function getCachedLaunches(limit, order, apiKey) {
  const key = defaultBankrApiKey(apiKey);
  if (!key) return [];
  const cacheKey = `${bankrKeyFingerprint(key)}:${limit}:${order ?? "newest"}`;
  const now = Date.now();
  if (_listCache && _listCacheKey === cacheKey && now - _listCacheTime < LIST_CACHE_TTL_MS) {
    return _listCache;
  }
  _listCache = await fetchAllLaunches(limit, order, key);
  _listCacheKey = cacheKey;
  _listCacheTime = now;
  return _listCache;
}

/** Fetch launches from Bankr API (paginated, parallel). order: undefined (newest first) or "asc" (oldest first). apiKey: optional override. */
async function fetchAllLaunches(limit = BANKR_LAUNCHES_LIMIT, order, apiKey) {
  const key = defaultBankrApiKey(apiKey);
  if (!key) return [];
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
    const batches = await Promise.all(batchOffsets.map((o) => fetchLaunchesPage(o, pageSize, order, key)));
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
  const xFrom = (obj) => obj?.xUsername ?? obj?.twitter ?? obj?.x ?? obj?.socials?.twitter ?? obj?.socials?.x;
  const fcFrom = (obj) => obj?.farcasterUsername ?? obj?.farcaster ?? obj?.fcUsername ?? obj?.fc;
  const add = (handle, wallet) => {
    if (!handle || !wallet) return;
    const h = norm(String(handle).replace(/^@/, ""));
    if (h) map.set(h, wallet);
  };
  for (const l of launches) {
    const d = l.deployer;
    const f = l.feeRecipient;
    const dw = walletFrom(d);
    const fw = walletFrom(f);
    if (dw) {
      if (xFrom(d)) add(xFrom(d), dw);
      const fc = fcFrom(d);
      if (fc) add(fc, dw);
    }
    if (fw) {
      if (xFrom(f)) add(xFrom(f), fw);
      const fc = fcFrom(f);
      if (fc) add(fc, fw);
    }
  }
  return map;
}

/** Search query variants for handle resolution (Bankr sometimes matches profile URLs better than bare handles). */
function searchQueriesForHandle(normalizedHandle) {
  const n = norm(normalizedHandle);
  if (!n) return [];
  const out = [];
  const add = (s) => {
    const t = String(s).trim();
    if (t && !out.includes(t)) out.push(t);
  };
  add(n);
  add(`@${n}`);
  add(`https://x.com/${n}`);
  add(`https://twitter.com/${n}`);
  return out;
}

/**
 * When deploy-simulate and newest/oldest list scans miss a handle, Bankr's search endpoint often still
 * returns launches where that X/Farcaster is deployer or fee recipient (same data as bankr.bot/search).
 * Uses launchWallet() so top-level deployerWallet/feeRecipientWallet match bankr.bot when nested objects are sparse.
 * If exactly one wallet matches the handle across those rows, return it (else null).
 * @param {unknown[]} launches - Raw launch objects from search API
 * @param {string} normalizedHandle - parseQuery normalized handle (lowercase, no @)
 * @returns {string|null}
 */
function inferWalletFromRawLaunches(launches, normalizedHandle) {
  const q = norm(normalizedHandle);
  if (!q || !Array.isArray(launches) || launches.length === 0) return null;
  const xFrom = (obj) => obj?.xUsername ?? obj?.twitter ?? obj?.x ?? obj?.socials?.twitter ?? obj?.socials?.x;
  const fcFrom = (obj) => obj?.farcasterUsername ?? obj?.farcaster ?? obj?.fcUsername ?? obj?.fc;
  const wallets = new Set();
  const matchX = (xu) => xu && norm(String(xu).replace(/^@/, "")) === q;
  const matchFc = (fc) => fc && norm(String(fc)) === q;

  for (const l of launches) {
    if (l?.status && l.status !== "deployed") continue;
    const dw = launchWallet(l, "deployer");
    const fw = launchWallet(l, "fee");
    const d = l.deployer;
    const f = l.feeRecipient;

    const deployerXCandidates = [xFrom(d), l.deployerX, l.deployerUsername, d?.username].filter(Boolean);
    const feeXCandidates = [xFrom(f), l.feeRecipientX, l.feeUsername, f?.username].filter(Boolean);
    const deployerFcCandidates = [fcFrom(d), l.deployerFc, l.deployerFarcasterUsername].filter(Boolean);
    const feeFcCandidates = [fcFrom(f), l.feeRecipientFc, l.feeFarcasterUsername].filter(Boolean);

    if (dw) {
      for (const xu of deployerXCandidates) {
        if (matchX(xu)) wallets.add(dw);
      }
      for (const fc of deployerFcCandidates) {
        if (matchFc(fc)) wallets.add(dw);
      }
    }
    if (fw) {
      for (const xu of feeXCandidates) {
        if (matchX(xu)) wallets.add(fw);
      }
      for (const fc of feeFcCandidates) {
        if (matchFc(fc)) wallets.add(fw);
      }
    }
  }
  if (wallets.size === 1) return [...wallets][0];
  return null;
}

/** Get wallet from deployer or fee object (API may use walletAddress, wallet, address, or raw string). */
function walletFrom(obj) {
  if (obj == null) return null;
  if (typeof obj === "string" && /^0x[a-fA-F0-9]{40}$/.test(obj.trim())) return obj.trim().toLowerCase();
  const w = obj.walletAddress ?? obj.wallet ?? obj.address;
  return w && /^0x[a-fA-F0-9]{40}$/.test(String(w).trim()) ? String(w).trim().toLowerCase() : null;
}

/** Get wallet from launch (nested deployer/fee or top-level deployerWallet/feeRecipientWallet). */
export function launchWallet(launch, role) {
  if (role === "deployer") {
    // Prefer API top-level launcher wallet (matches bankr.bot / search grouping); nested deployer can differ.
    return walletFrom(launch.deployerWallet) ?? walletFrom(launch.deployerWalletAddress) ?? walletFrom(launch.deployer);
  }
  if (role === "fee") {
    const w = walletFrom(launch.feeRecipient) ?? (launch.feeRecipientWallet && /^0x[a-fA-F0-9]{40}$/.test(String(launch.feeRecipientWallet).trim()) ? String(launch.feeRecipientWallet).trim().toLowerCase() : null);
    return w ?? (launch.creatorWallet && /^0x[a-fA-F0-9]{40}$/.test(String(launch.creatorWallet).trim()) ? String(launch.creatorWallet).trim().toLowerCase() : null);
  }
  return null;
}

/**
 * When handle/FC search returns tokens but resolveHandleToWallet missed (e.g. not in list window),
 * infer the wallet from match rows so Bankr search links use q=0x… like the site.
 * @param {Array<{ deployerWallet?: string|null, feeRecipientWallet?: string|null, deployerX?: string|null, deployerFc?: string|null, feeRecipientX?: string|null, feeRecipientFc?: string|null }>} matches
 * @param {string} normalizedHandle - from parseQuery (lowercase handle, no @)
 * @returns {string|null}
 */
function inferWalletFromHandleMatches(matches, normalizedHandle) {
  const q = norm(normalizedHandle);
  if (!q || !Array.isArray(matches) || matches.length === 0) return null;
  const wallets = new Set();
  for (const m of matches) {
    const dx = m.deployerX ? norm(String(m.deployerX).replace(/^@/, "")) : null;
    const fx = m.feeRecipientX ? norm(String(m.feeRecipientX).replace(/^@/, "")) : null;
    const df = m.deployerFc ? norm(String(m.deployerFc)) : null;
    const ff = m.feeRecipientFc ? norm(String(m.feeRecipientFc)) : null;
    if (dx === q && m.deployerWallet) wallets.add(String(m.deployerWallet).toLowerCase());
    if (fx === q && m.feeRecipientWallet) wallets.add(String(m.feeRecipientWallet).toLowerCase());
    if (df === q && m.deployerWallet) wallets.add(String(m.deployerWallet).toLowerCase());
    if (ff === q && m.feeRecipientWallet) wallets.add(String(m.feeRecipientWallet).toLowerCase());
  }
  if (wallets.size === 1) return [...wallets][0];
  return null;
}

/** Check if a launch matches the query. filter: "deployer" | "fee" | "both". */
function launchMatches(launch, queryNorm, isWalletQuery, filter = "both") {
  const deployer = launch.deployer;
  const fee = launch.feeRecipient;
  const deployerWallet = launchWallet(launch, "deployer");
  const feeWallet = launchWallet(launch, "fee");

  const matchDeployer = () => {
    if (isWalletQuery) return deployerWallet === queryNorm;
    const q = queryNorm;
    const deployerX = deployer?.xUsername ? norm(String(deployer.xUsername).replace(/^@/, "")) : null;
    const deployerFc = norm(deployer?.farcasterUsername ?? deployer?.farcaster ?? deployer?.fcUsername ?? "");
    return deployerX === q || deployerFc === q;
  };
  const matchFee = () => {
    if (isWalletQuery) return feeWallet === queryNorm;
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
export function parseQuery(query) {
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
 * Order: overrides → deploy simulate → newest + optional oldest list map → token-launches/search inference
 * (search matches bankr.bot; fills gaps when simulate or list window misses the handle).
 * Uses options.bankrApiKey when provided; otherwise BANKR_API_KEY from env.
 * @param {string} query
 * @param {{ bankrApiKey?: string }} [options]
 * @returns { Promise<{ wallet: string | null, normalized: string | null, isWallet: boolean }> }
 */
export async function resolveHandleToWallet(query, options = {}) {
  const apiKey = defaultBankrApiKey(options.bankrApiKey);
  const { normalized, isWallet } = parseQuery(query);
  if (!normalized) return { wallet: null, normalized: null, isWallet: false };
  if (isWallet) return { wallet: normalized, normalized, isWallet: true };
  const overrides = getHandleOverrides();
  const overrideWallet = overrides.get(normalized);
  if (overrideWallet) return { wallet: overrideWallet, normalized, isWallet: false };
  if (!apiKey) return { wallet: null, normalized, isWallet: false };
  // Try deploy-simulate first: one POST, no list fetches. Works even when list API is 429'd.
  let wallet = await resolveHandleViaDeploySimulate(normalized, apiKey) ?? null;
  if (!wallet) {
    const all = await fetchAllLaunches(undefined, undefined, apiKey);
    let handleToWallet = buildHandleToWalletMap(all);
    wallet = handleToWallet.get(normalized) ?? null;
    if (!wallet && OLDEST_FETCH_LIMIT > 0) {
      const oldest = await fetchAllLaunches(OLDEST_FETCH_LIMIT, "asc", apiKey);
      const mapOld = buildHandleToWalletMap(oldest);
      for (const [h, w] of mapOld) if (!handleToWallet.has(h)) handleToWallet.set(h, w);
      wallet = handleToWallet.get(normalized) ?? null;
    }
  }
  // Same discovery path as /lookup when list+simulate miss: search API often still returns the handle on launches.
  if (!wallet) {
    const tried = new Set();
    for (const sq of searchQueriesForHandle(normalized)) {
      const k = sq.toLowerCase();
      if (tried.has(k)) continue;
      tried.add(k);
      const sr = await fetchSearch(sq, apiKey);
      if (sr?.launches?.length) {
        const w = inferWalletFromRawLaunches(sr.launches, normalized);
        if (w) {
          wallet = w;
          break;
        }
      }
    }
  }
  return { wallet, normalized, isWallet: false };
}

/**
 * Resolve a handle to wallet by calling Bankr deploy API with simulateOnly: true.
 * Bankr resolves fee recipient (x/farcaster) server-side; the response includes feeDistribution.creator with the resolved address.
 * apiKey: required for the request (env or passed from caller).
 * @param {string} handle - Normalized handle (no @).
 * @param {string} [apiKey] - Bankr API key (uses env if not provided).
 * @returns {Promise<string | null>} Resolved wallet (lowercase) or null.
 */
async function resolveHandleViaDeploySimulate(handle, apiKey) {
  const key = defaultBankrApiKey(apiKey);
  if (!key || !handle) return null;
  const typesToTry = /\.(eth|lens)$/.test(handle) ? ["ens", "farcaster", "x"] : ["x", "farcaster", "ens"];
  for (const type of typesToTry) {
    try {
      const res = await fetch(DEPLOY_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": key.trim() },
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
      if (res.ok && data?.success) console.warn("[resolve] Deploy simulate ok but no creator address; keys:", Object.keys(data?.feeDistribution ?? {}));
    } catch {
      // ignore and try next type
    }
  }
  return null;
}

/** @param filter "deployer" | "fee" | "both" - limit to tokens where query matches deployer, fee recipient, or either
 *  @param sortOrder "newest" | "oldest" - newest first (default) or oldest first
 *  @param options { bankrApiKey?: string, lookupDepth?: number } - bankrApiKey from /setup or env; lookupDepth internal (wallet retry). */
export async function lookupByDeployerOrFee(query, filter = "both", sortOrder = "newest", options = {}) {
  const lookupDepth = Number(options.lookupDepth) || 0;
  const { lookupDepth: _omitLd, ...optsRest } = options;
  const apiKey = defaultBankrApiKey(optsRest.bankrApiKey);
  const { normalized, isWallet: isWalletQuery } = parseQuery(query);
  if (!normalized) {
    const q = String(query).trim();
    const searchUrl = q
      ? `https://bankr.bot/launches/search?q=${encodeURIComponent(q)}`
      : "https://bankr.bot/launches/search";
    return {
      matches: [],
      totalCount: 0,
      query,
      normalized: null,
      resolvedWallet: null,
      possiblyCapped: false,
      hasDates: false,
      isWalletQuery: false,
      searchUrl,
    };
  }

  // When query is X/FC handle, resolve to wallet first so we always search by wallet (avoids "do resolve then lookup" manually)
  let resolvedWallet = null;
  if (!isWalletQuery && normalized) {
    const resolved = await resolveHandleToWallet(query, { bankrApiKey: apiKey });
    if (resolved.wallet) resolvedWallet = resolved.wallet;
  }

  const effectiveQuery = resolvedWallet ?? normalized;
  const matches = (l) => launchMatches(l, effectiveQuery, isWalletQuery || !!resolvedWallet, filter);
  let launches = [];
  let totalCount = 0;

  // Wallet (or resolved wallet): with API key we merge list + search (search matches bankr.bot; list fills gaps). Without key, search-only path below.
  const useWalletOnlyPath = (isWalletQuery || !!resolvedWallet) && !!apiKey;
  let searchResult = null;
  if (!useWalletOnlyPath) {
    searchResult = await fetchSearch(effectiveQuery, apiKey);
    if (!resolvedWallet && normalized && !normalized.startsWith("@")) {
      const filteredFromFirst = searchResult ? searchResult.launches.filter(matches) : [];
      if (filteredFromFirst.length === 0) {
        const withAt = await fetchSearch("@" + normalized, apiKey);
        if (withAt && withAt.launches.length > 0) {
          searchResult = searchResult
            ? { launches: [...new Map([...searchResult.launches, ...withAt.launches].map((l) => [l.tokenAddress?.toLowerCase(), l])).values()], totalCount: Math.max(searchResult.totalCount, withAt.totalCount) }
            : withAt;
        }
      }
    }
  }
  if (searchResult) {
    launches = searchResult.launches.filter(matches);
    totalCount = searchResult.totalCount;
  }

  if (apiKey) {
    const isWalletOnly = isWalletQuery || !!resolvedWallet;
    const listLimit = isWalletOnly ? BANKR_WALLET_LOOKUP_LIMIT : BANKR_LAUNCHES_LIMIT;
    let all = await getCachedLaunches(listLimit, undefined, apiKey);
    let handleToWallet = buildHandleToWalletMap(all);
    for (const [h, w] of getHandleOverrides()) handleToWallet.set(h, w);
    if (!handleToWallet.has(normalized) && OLDEST_FETCH_LIMIT > 0) {
      const oldest = await fetchAllLaunches(OLDEST_FETCH_LIMIT, "asc", apiKey);
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
    mergeLaunchesWithoutDuplicates(launches, all.filter(matches));
    totalCount = Math.max(launches.length, totalCount);
    // Always merge search for wallet queries: bankr.bot/launches/search can list tokens that are not in the
    // newest-N list window we scan. Previously we only called search when the list returned 0 → under-counted
    // fee recipient / deployer (e.g. Recipient: 1 while search shows 3 results).
    if (useWalletOnlyPath && effectiveQuery) {
      const walletSearch = await fetchSearch(effectiveQuery, apiKey);
      if (walletSearch?.launches?.length) {
        // Search is already scoped to this wallet; do not re-filter with launchMatches() — API rows may omit
        // nested deployer/fee objects that launchWallet() needs, which caused 0 matches despite a resolved wallet.
        const extra = walletSearch.launches.filter((l) => l.status === "deployed" && l.tokenAddress);
        mergeLaunchesWithoutDuplicates(launches, extra);
        totalCount = Math.max(totalCount, walletSearch.totalCount ?? 0, launches.length);
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
      deployerWallet: launchWallet(l, "deployer"),
      deployerX: l.deployer?.xUsername ?? null,
      deployerFc: l.deployer?.farcasterUsername ?? l.deployer?.farcaster ?? l.deployer?.fcUsername ?? null,
      feeRecipientWallet: launchWallet(l, "fee"),
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

  let finalResolvedWallet = resolvedWallet;
  if (!finalResolvedWallet && !isWalletQuery && normalized && result.length > 0) {
    finalResolvedWallet = inferWalletFromHandleMatches(result, normalized);
  }

  // Handle query returned 0 merged rows but search can still infer a single wallet — rerun as wallet lookup once
  // (fixes cross-key list cache / edge cases where first pass didn't resolve before merge).
  if (
    lookupDepth === 0 &&
    result.length === 0 &&
    !isWalletQuery &&
    normalized &&
    apiKey &&
    !finalResolvedWallet
  ) {
    let lateWallet = null;
    const triedLate = new Set();
    for (const sq of searchQueriesForHandle(normalized)) {
      const k = sq.toLowerCase();
      if (triedLate.has(k)) continue;
      triedLate.add(k);
      const sr = await fetchSearch(sq, apiKey);
      if (sr?.launches?.length) {
        lateWallet = inferWalletFromRawLaunches(sr.launches, normalized);
        if (lateWallet) break;
      }
    }
    if (lateWallet) {
      return lookupByDeployerOrFee(lateWallet, filter, sortOrder, { ...optsRest, lookupDepth: 1 });
    }
  }

  const searchUrl = `https://bankr.bot/launches/search?q=${encodeURIComponent(finalResolvedWallet ?? normalized)}`;

  return {
    query,
    normalized,
    totalCount,
    possiblyCapped,
    hasDates,
    isWalletQuery,
    resolvedWallet: finalResolvedWallet ?? null,
    matches: result,
    searchUrl,
  };
}

/**
 * Count Bankr tokens where this wallet is deployer vs fee recipient (aligned with bankr.bot/launches/search + /lookup).
 * Uses the same list/search merge as lookupByDeployerOrFee — needs BANKR_API_KEY (or options.bankrApiKey).
 * Results cached per wallet (see BANKR_WALLET_ROLE_COUNT_TTL_MS).
 * @returns {{ asDeployer: number|null, asFeeRecipient: number|null, source: 'bankr'|null, bankrSearchUrl: string|null, possiblyCapped?: boolean }}
 */
export async function getBankrWalletLaunchRoleCounts(walletAddress, options = {}) {
  const w = walletAddress && String(walletAddress).trim().toLowerCase();
  if (!w || !/^0x[a-f0-9]{40}$/.test(w)) {
    return { asDeployer: null, asFeeRecipient: null, source: null, bankrSearchUrl: null };
  }
  const apiKey = defaultBankrApiKey(options.bankrApiKey);
  if (!apiKey) {
    return {
      asDeployer: null,
      asFeeRecipient: null,
      source: null,
      bankrSearchUrl: `https://bankr.bot/launches/search?q=${encodeURIComponent(w)}`,
    };
  }
  const now = Date.now();
  const cached = bankrWalletRoleCountCache.get(w);
  if (cached && now - cached.t < BANKR_WALLET_ROLE_COUNT_TTL_MS) {
    return cached.data;
  }
  try {
    const result = await lookupByDeployerOrFee(w, "both", "newest", { bankrApiKey: apiKey });
    const asDeployer = new Set();
    const asFee = new Set();
    for (const m of result.matches) {
      const ca = m.tokenAddress?.toLowerCase();
      if (!ca) continue;
      if (m.deployerWallet?.toLowerCase() === w) asDeployer.add(ca);
      if (m.feeRecipientWallet?.toLowerCase() === w) asFee.add(ca);
    }
    const nDep = asDeployer.size;
    const nFee = asFee.size;
    const data = {
      asDeployer: nDep > 0 ? nDep : null,
      asFeeRecipient: nFee > 0 ? nFee : null,
      source: "bankr",
      bankrSearchUrl: `https://bankr.bot/launches/search?q=${encodeURIComponent(w)}`,
      possiblyCapped: result.possiblyCapped,
    };
    bankrWalletRoleCountCache.set(w, { t: now, data });
    return data;
  } catch {
    return {
      asDeployer: null,
      asFeeRecipient: null,
      source: null,
      bankrSearchUrl: `https://bankr.bot/launches/search?q=${encodeURIComponent(w)}`,
    };
  }
}

function normLaunchWallet(addr) {
  const s = addr && String(addr).trim().toLowerCase();
  return s && /^0x[a-f0-9]{40}$/.test(s) ? s : null;
}

function feeWalletFromLaunchBeneficiary(launch) {
  const b0 = launch?.beneficiaries?.[0];
  if (!b0) return null;
  const raw = typeof b0 === "object" ? b0.beneficiary ?? b0.address ?? b0.wallet : b0;
  return normLaunchWallet(raw);
}

/**
 * Add bankrDeployCount / bankrFeeRecipientCount (same basis as bankr.bot search). Used by Discord bot + notify/Telegram.
 * @param {object} launch - Normalized launch { launcher, beneficiaries, ... }
 * @param {{ bankrApiKey?: string }} [options]
 */
export async function enrichLaunchWithBankrRoleCounts(launch, options = {}) {
  const bankrApiKey = defaultBankrApiKey(options.bankrApiKey);
  if (!bankrApiKey || !launch) return launch;
  const launcher = normLaunchWallet(launch?.launcher);
  const fee = feeWalletFromLaunchBeneficiary(launch);
  if (!launcher && !fee) return launch;
  try {
    if (launcher && fee && launcher === fee) {
      const c = await getBankrWalletLaunchRoleCounts(launcher, { bankrApiKey });
      return {
        ...launch,
        ...(c.asDeployer != null && { bankrDeployCount: c.asDeployer }),
        ...(c.asFeeRecipient != null && { bankrFeeRecipientCount: c.asFeeRecipient }),
      };
    }
    let cLauncher = null;
    let cFeeWallet = null;
    if (launcher) cLauncher = await getBankrWalletLaunchRoleCounts(launcher, { bankrApiKey }).catch(() => null);
    if (fee && fee !== launcher) cFeeWallet = await getBankrWalletLaunchRoleCounts(fee, { bankrApiKey }).catch(() => null);
    const bankrDeployCount = cLauncher?.asDeployer;
    const bankrFeeRecipientCount = fee && fee !== launcher ? cFeeWallet?.asFeeRecipient : undefined;
    return {
      ...launch,
      ...(bankrDeployCount != null && { bankrDeployCount }),
      ...(bankrFeeRecipientCount != null && { bankrFeeRecipientCount }),
    };
  } catch {
    return launch;
  }
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
