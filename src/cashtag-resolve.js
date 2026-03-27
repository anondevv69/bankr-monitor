/**
 * Resolve cashtags ($TST) to Bankr token CAs via Doppler indexer (symbol search → filter → rank by mcap).
 * Contract address is authoritative; symbol is only a search key.
 */

import { isBankrTokenAddress } from "./bankr-token.js";
import { numFromScaled } from "./token-trend-card.js";

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
 * Resolve a ticker to the Bankr token with highest indexed mcap among symbol matches.
 * @param {string} rawSymbol - e.g. TST (no $)
 * @param {{ chainId?: number, dopplerIndexerUrl?: string, bypassCache?: boolean }} [options]
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

  const candidates = await fetchCandidatesForSymbol(indexerBase, chainId, normalized);
  const bankrOnly = candidates.filter((t) => isBankrTokenAddress(t.address));
  if (bankrOnly.length === 0) {
    if (!options.bypassCache) resolveCache.set(cacheKey, { at: Date.now(), value: null });
    return null;
  }

  const scored = bankrOnly.map((t) => {
    const pool = t.pool;
    const mcapUsd = numFromScaled(pool?.marketCapUsd, USD_1E18);
    const liquidityUsd = numFromScaled(pool?.dollarLiquidity, USD_1E18);
    const volPool = numFromScaled(pool?.volumeUsd, USD_1E18);
    const volTok = numFromScaled(t.volumeUsd, USD_1E18);
    const volume24hUsd = Math.max(volPool, volTok);
    const stale = isPoolActivityStale(pool, t);
    return {
      t,
      mcapUsd,
      liquidityUsd,
      volume24hUsd,
      stale,
      score: rankScore(mcapUsd, liquidityUsd, volume24hUsd, stale),
    };
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
