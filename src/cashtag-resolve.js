/**
 * Resolve cashtags ($TST) to Bankr token CAs: Doppler indexer symbol search + Bankr search API (groups.tokens)
 * + rank by max(indexer mcap, DexScreener mcap). Some launches are not yet in the indexer; Bankr search fills the gap.
 */

import { isBankrTokenAddress } from "./bankr-token.js";
import { numFromScaled } from "./token-trend-card.js";
import { defaultBankrApiKey } from "./bankr-env-key.js";
import { fetchSearch } from "./lookup-deployer.js";
import { fetchDexScreenerMetricsForToken } from "./token-stats.js";

/**
 * @typedef {object} CashtagResolveResult
 * @property {string} symbol
 * @property {number} chainId
 * @property {string} address
 * @property {string} name
 * @property {object | null} pool
 * @property {number} mcapUsd
 * @property {number} liquidityUsd
 * @property {number} volume24hUsd
 * @property {boolean} stale
 * @property {number} score
 */

const CHAIN_ID = parseInt(process.env.CHAIN_ID || "8453", 10);
const DEFAULT_INDEXER =
  CHAIN_ID === 8453 ? "https://bankr.indexer.doppler.lol" : "https://testnet-indexer.doppler.lol";

const USD_1E18 = 1e18;

const CASHTAG_RESOLVE_TTL_MS = Math.min(
  Math.max(parseInt(process.env.CASHTAG_RESOLVE_TTL_MS || "45000", 10), 15000),
  120000
);
const MIN_LIQ_USD = Math.max(0, parseFloat(process.env.CASHTAG_MIN_LIQUIDITY_USD || "20000") || 20000);
const MIN_VOL24_USD = Math.max(0, parseFloat(process.env.CASHTAG_MIN_VOLUME24_USD || "50000") || 50000);
const SYMBOL_QUERY_LIMIT = Math.min(Math.max(parseInt(process.env.CASHTAG_SYMBOL_QUERY_LIMIT || "200", 10), 20), 500);
const MAX_CANDIDATE_ADDRESSES = Math.min(Math.max(parseInt(process.env.CASHTAG_MAX_CANDIDATES || "50", 10), 15), 80);
const DEX_FETCH_CONCURRENCY = Math.min(Math.max(parseInt(process.env.CASHTAG_DEX_FETCH_CONCURRENCY || "6", 10), 2), 12);

/** @type {Map<string, { at: number, value: CashtagResolveResult | null }>} */
const resolveCache = new Map();

export const CASHTAG_RE = /\$([A-Za-z0-9_]{2,15})\b/g;

/**
 * @param {string} text
 * @returns {string[]} Uppercased symbols (deduped in order)
 */
export function extractTickers(text) {
  const seen = new Set();
  const out = [];
  for (const m of String(text || "").matchAll(CASHTAG_RE)) {
    const u = m[1].toUpperCase();
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

function gqlEscape(str) {
  return String(str).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * @param {string} ts
 * @returns {number | null} Unix seconds
 */
function bucketTimestampSec(ts) {
  if (ts == null || ts === "") return null;
  const n = Number(ts);
  if (!Number.isFinite(n)) return null;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

/**
 * @param {object | null} pool
 * @param {object | null} token
 * @param {number} [nowSec]
 * @returns {boolean}
 */
export function isPoolActivityStale(pool, token, nowSec = Math.floor(Date.now() / 1000)) {
  const volPool = numFromScaled(pool?.volumeUsd, USD_1E18);
  const volTok = numFromScaled(token?.volumeUsd, USD_1E18);
  const impliedVol = Math.max(volPool, volTok);
  const items = pool?.volumeBuckets24h?.items ?? [];
  const b0 = items[0];
  if (b0) {
    const ts = bucketTimestampSec(b0.timestamp);
    const tx = Number(b0.txCount) || 0;
    const ageSec = ts != null ? nowSec - ts : Number.POSITIVE_INFINITY;
    if (tx > 0 && ageSec <= 6 * 3600) return false;
    if (tx > 0 && ageSec > 6 * 3600) return true;
    if (tx === 0 && impliedVol >= MIN_VOL24_USD) return false;
    return true;
  }
  return impliedVol < 500;
}

async function fetchTokensByExactSymbol(indexerBase, chainId, symbolExact) {
  const sym = gqlEscape(symbolExact);
  const query = `query {
    tokens(where: { chainId: ${chainId}, symbol: "${sym}" }, limit: ${SYMBOL_QUERY_LIMIT}) {
      items {
        address name symbol
        volumeUsd
        pool {
          address
          marketCapUsd
          dollarLiquidity
          volumeUsd
          volumeBuckets24h(limit: 1, orderBy: "timestamp", orderDirection: "desc") {
            items { timestamp txCount volumeUsd }
          }
        }
      }
    }
  }`;
  try {
    const res = await fetch(`${indexerBase}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return [];
    const json = await res.json();
    if (json.errors?.length) return [];
    return json.data?.tokens?.items ?? [];
  } catch {
    return [];
  }
}

async function fetchCandidatesForSymbol(indexerBase, chainId, normalizedUpper) {
  const upper = normalizedUpper;
  const lower = normalizedUpper.toLowerCase();
  const variants = upper === lower ? [upper] : [upper, lower];
  const seen = new Set();
  const merged = [];
  for (const sym of variants) {
    const items = await fetchTokensByExactSymbol(indexerBase, chainId, sym);
    for (const t of items) {
      const k = (t.address || "").toLowerCase();
      if (k && !seen.has(k)) {
        seen.add(k);
        merged.push(t);
      }
    }
  }
  return merged;
}

/**
 * Bankr search API returns symbol matches under groups.tokens — includes tokens not yet in the Doppler indexer.
 * @param {string} normalizedUpper
 * @param {string | undefined} apiKey
 * @returns {Promise<object[]>}
 */
async function fetchBankrSearchLaunchesForSymbol(normalizedUpper, apiKey) {
  const res = await fetchSearch(normalizedUpper, defaultBankrApiKey(apiKey));
  return res?.launches ?? [];
}

/**
 * @param {object[]} indexerItems
 * @param {object[]} bankrLaunches
 * @param {string} normalizedUpper
 * @returns {{ addr: string, t: object }[]}
 */
function mergeIndexerAndBankrLaunches(indexerItems, bankrLaunches, normalizedUpper) {
  /** @type {Map<string, { t: object | null, launch: object | null }>} */
  const map = new Map();
  for (const t of indexerItems) {
    const a = (t.address || "").toLowerCase();
    if (!a || !isBankrTokenAddress(a)) continue;
    map.set(a, { t, launch: null });
  }
  for (const l of bankrLaunches) {
    if (l.status !== "deployed") continue;
    if (String(l.chain || "").toLowerCase() !== "base") continue;
    if (String(l.tokenSymbol || "").toUpperCase() !== normalizedUpper) continue;
    const a = l.tokenAddress?.toLowerCase();
    if (!a || !isBankrTokenAddress(a)) continue;
    const prev = map.get(a);
    if (!prev) map.set(a, { t: null, launch: l });
    else prev.launch = l;
  }
  const rows = [];
  for (const [addr, entry] of map) {
    const t =
      entry.t ??
      ({
        address: entry.launch.tokenAddress,
        name: entry.launch.tokenName,
        symbol: entry.launch.tokenSymbol,
        pool: null,
        volumeUsd: null,
      });
    rows.push({ addr, t });
  }
  return rows;
}

/** Prefer all indexer-missing (Bankr-only) rows, then top indexer mcap rows, up to max. */
function capCandidateRows(rows, max) {
  if (rows.length <= max) return rows;
  const indexerMcap = (r) => numFromScaled(r.t.pool?.marketCapUsd, USD_1E18);
  const noPool = rows.filter((r) => !r.t.pool);
  const withPool = rows.filter((r) => r.t.pool);
  withPool.sort((a, b) => indexerMcap(b) - indexerMcap(a));
  if (noPool.length >= max) return noPool.slice(0, max);
  const budget = max - noPool.length;
  return [...noPool, ...withPool.slice(0, Math.max(0, budget))];
}

async function mapInChunks(items, chunkSize, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    out.push(...(await Promise.all(chunk.map(fn))));
  }
  return out;
}

function passesLiquidityVolumeFloor(liquidityUsd, volume24hUsd) {
  return liquidityUsd >= MIN_LIQ_USD || volume24hUsd >= MIN_VOL24_USD;
}

function rankScore(mcapUsd, liquidityUsd, volume24hUsd, stale) {
  const logLiq = Math.log10((liquidityUsd || 0) + 1);
  const logVol = Math.log10((volume24hUsd || 0) + 1);
  const active = stale ? 0 : 1;
  return 0.5 * Math.log10((mcapUsd || 0) + 1) + 0.35 * logLiq + 0.15 * logVol + 0.1 * active;
}

/**
 * Resolve a ticker to the Bankr token with highest mcap (indexer vs DexScreener, merged with Bankr search).
 * @param {string} rawSymbol - e.g. TST (no $)
 * @param {{ chainId?: number, dopplerIndexerUrl?: string, bypassCache?: boolean, bankrApiKey?: string }} [options]
 * @returns {Promise<CashtagResolveResult | null>}
 */
export async function resolveCashtagToBankrToken(rawSymbol, options = {}) {
  const chainId = options.chainId ?? CHAIN_ID;
  const indexerBase = (options.dopplerIndexerUrl || process.env.DOPPLER_INDEXER_URL || DEFAULT_INDEXER).replace(
    /\/$/,
    ""
  );
  const sym = String(rawSymbol || "")
    .trim()
    .replace(/^\$/, "");
  if (!/^[A-Za-z0-9_]{2,15}$/.test(sym)) return null;

  const normalized = sym.toUpperCase();
  const cacheKey = `${chainId}:${normalized}`;
  if (!options.bypassCache) {
    const hit = resolveCache.get(cacheKey);
    if (hit && Date.now() - hit.at < CASHTAG_RESOLVE_TTL_MS) {
      return hit.value;
    }
  }

  const [indexerItems, bankrLaunches] = await Promise.all([
    fetchCandidatesForSymbol(indexerBase, chainId, normalized),
    fetchBankrSearchLaunchesForSymbol(normalized, options.bankrApiKey),
  ]);

  const rows = mergeIndexerAndBankrLaunches(indexerItems, bankrLaunches, normalized);
  if (rows.length === 0) {
    if (!options.bypassCache) resolveCache.set(cacheKey, { at: Date.now(), value: null });
    return null;
  }

  const capped = capCandidateRows(rows, MAX_CANDIDATE_ADDRESSES);

  const scored = await mapInChunks(capped, DEX_FETCH_CONCURRENCY, async ({ addr, t }) => {
    const pool = t.pool;
    const idxMcap = numFromScaled(pool?.marketCapUsd, USD_1E18);
    const idxLiq = numFromScaled(pool?.dollarLiquidity, USD_1E18);
    const volPool = numFromScaled(pool?.volumeUsd, USD_1E18);
    const volTok = numFromScaled(t.volumeUsd, USD_1E18);
    const dex = await fetchDexScreenerMetricsForToken(addr);
    const dexMcap = dex?.marketCapUsd ?? 0;
    const dexLiq = dex?.liquidityUsd ?? 0;
    const mcapUsd = Math.max(idxMcap, dexMcap);
    const liquidityUsd = Math.max(idxLiq, dexLiq);
    const volume24hUsd = Math.max(volPool, volTok);
    let stale;
    if (pool) {
      stale = isPoolActivityStale(pool, t);
    } else {
      const tr = dex?.trades24h;
      const n = (tr?.buys ?? 0) + (tr?.sells ?? 0);
      stale = n <= 0 && (mcapUsd <= 0 || liquidityUsd < 100);
    }
    const score = rankScore(mcapUsd, liquidityUsd, volume24hUsd, stale);
    return { t, mcapUsd, liquidityUsd, volume24hUsd, stale, score };
  });

  const eligible = scored.filter((x) => passesLiquidityVolumeFloor(x.liquidityUsd, x.volume24hUsd));
  const poolPick = (eligible.length > 0 ? eligible : scored).sort((a, b) => {
    if (b.mcapUsd !== a.mcapUsd) return b.mcapUsd - a.mcapUsd;
    return b.score - a.score;
  })[0];

  if (!poolPick) {
    if (!options.bypassCache) resolveCache.set(cacheKey, { at: Date.now(), value: null });
    return null;
  }

  const best = poolPick.t;
  const result = {
    symbol: normalized,
    chainId,
    address: String(best.address).toLowerCase(),
    name: best.name || "",
    pool: best.pool || null,
    mcapUsd: poolPick.mcapUsd,
    liquidityUsd: poolPick.liquidityUsd,
    volume24hUsd: poolPick.volume24hUsd,
    stale: poolPick.stale,
    score: poolPick.score,
  };

  if (!options.bypassCache) resolveCache.set(cacheKey, { at: Date.now(), value: result });
  return result;
}

/**
 * @param {CashtagResolveResult} r
 * @returns {string} Short HTML-safe line for Telegram (caller sets parse mode)
 */
export function formatCashtagResolvePreambleHtml(r) {
  const ca = r.address;
  const staleNote = r.stale ? " · <i>stale</i> (weak recent activity in indexer)" : "";
  const m =
    r.mcapUsd >= 1e9
      ? `$${(r.mcapUsd / 1e9).toFixed(2)}B`
      : r.mcapUsd >= 1e6
        ? `$${(r.mcapUsd / 1e6).toFixed(2)}M`
        : r.mcapUsd >= 1e3
          ? `$${(r.mcapUsd / 1e3).toFixed(1)}K`
          : `$${r.mcapUsd.toFixed(0)}`;
  return `Resolved <b>$${r.symbol}</b> → highest mcap Bankr match · mcap ~${m}<br/><code>${ca}</code>${staleNote}`;
}
