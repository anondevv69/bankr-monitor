#!/usr/bin/env node
/**
 * Show launch info and fee-relevant stats for any Bankr token by address.
 * - Bankr API: launch metadata (deployer, fee recipient).
 * - Doppler indexer: trading volume; cumulatedFees(poolId, chainId, beneficiary) for token0/token1/totalFeesUsd when the indexer supports it.
 * - Optional Doppler SDK: pool state (fee tier, status) via read-only getState().
 *
 * Usage: node src/token-stats.js <tokenAddress>
 * Example: node src/token-stats.js 0x9b40e8d9dda89230ea0e034ae2ef0f435db57ba3
 *
 * Env: BANKR_API_KEY (recommended; single-token launch endpoint may return 403 without it)
 *      DOPPLER_INDEXER_URL (optional; default https://bankr.indexer.doppler.lol for Base mainnet — set to your endpoint if different)
 *      CHAIN_ID (default 8453)
 */

import "dotenv/config";

import { parseAbiItem } from "viem";
import { DOPPLER_CONTRACTS_BASE } from "./config.js";
import { getClaimTxsFromBaseScan } from "./basescan-claims.js";

const CHAIN_ID = parseInt(process.env.CHAIN_ID || "8453", 10);
// Production indexer default for Base mainnet; override via env (e.g. your DM'd endpoint).
const DOPPLER_INDEXER_URL =
  process.env.DOPPLER_INDEXER_URL ||
  (CHAIN_ID === 8453 ? "https://bankr.indexer.doppler.lol" : "https://testnet-indexer.doppler.lol");
const BANKR_LAUNCH_URL = "https://api.bankr.bot/token-launches";
const BANKR_AGENT_PROFILES_URL = "https://api.bankr.bot/agent-profiles";
const BANKR_API_KEY = process.env.BANKR_API_KEY;
/** Base RPC URL for on-chain reads (claimable fees, pool state). Only RPC_URL_BASE is used; RPC_URL is fallback. */
const getBaseRpcUrl = () => process.env.RPC_URL_BASE || process.env.RPC_URL || "https://mainnet.base.org";
const DEXSCREENER_API_BASE = "https://api.dexscreener.com/latest/dex";

/**
 * Fetch Base token metrics from DexScreener (market cap, 24h buys/sells, optional m5/h1). No API key required.
 * @returns {{ marketCap: number, trades24h: { buys: number, sells: number }, buys5m?: number, buys1h?: number } | null}
 */
async function fetchDexScreenerBaseToken(tokenAddress) {
  try {
    const url = `${DEXSCREENER_API_BASE}/tokens/${tokenAddress}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data.pairs ?? [];
    const basePairs = pairs.filter(
      (p) => p.chainId === "base" || p.chainId === "8453"
    );
    if (basePairs.length === 0) return null;
    const best = basePairs.reduce((a, b) => {
      const aLiq = a.liquidity?.usd ?? 0;
      const bLiq = b.liquidity?.usd ?? 0;
      return bLiq > aLiq ? b : a;
    }, basePairs[0]);
    const marketCap = best.fdv ?? best.liquidity?.usd ?? null;
    const pairCreatedAt =
      best.pairCreatedAt != null ? Number(best.pairCreatedAt) : null;
    const txns = best.txns ?? best.transactions;
    const h24 = txns?.h24;
    const buys = h24?.buys ?? 0;
    const sells = h24?.sells ?? 0;
    const m5 = txns?.m5;
    const h1 = txns?.h1;
    const result = {
      marketCap: marketCap != null ? Number(marketCap) : null,
      trades24h: { buys: Number(buys), sells: Number(sells) },
    };
    if (Number.isFinite(pairCreatedAt) && pairCreatedAt > 0) {
      result.pairCreatedAt = pairCreatedAt;
    }
    if (m5 && typeof m5.buys === "number") result.buys5m = m5.buys;
    if (h1 && typeof h1.buys === "number") result.buys1h = h1.buys;
    return result;
  } catch {
    return null;
  }
}

/**
 * Fetch stats used for "hot launch" alerts: buys in last 5m/1h and holder count.
 * Deploy time (Bankr API still preferred in bot): Doppler token.pool.createdAt → firstSeenAt → Dex pairCreatedAt.
 * @returns {{ buys5m: number, buys1h: number, holderCount: number|null, marketCap: number|null, deployedAtMs: number|null } | null}
 */
export async function getHotTokenStats(tokenAddress) {
  const addr = normalizeAddress(tokenAddress);
  if (!addr) return null;
  try {
    const [dex, doppler] = await Promise.all([
      fetchDexScreenerBaseToken(addr),
      fetchDopplerTokenVolume(addr),
    ]);
    const buys5m = dex?.buys5m ?? dex?.trades24h?.buys ?? 0;
    const buys1h = dex?.buys1h ?? dex?.trades24h?.buys ?? 0;
    const holderCount = doppler?.holderCount != null ? Number(doppler.holderCount) : null;
    const marketCap = dex?.marketCap != null && Number.isFinite(dex.marketCap) ? dex.marketCap : null;
    const poolCreatedMs = ponderTimestampToMs(doppler?.pool?.createdAt);
    const firstSeenMs = ponderTimestampToMs(doppler?.firstSeenAt);
    let deployedAtMs = null;
    if (poolCreatedMs != null) deployedAtMs = poolCreatedMs;
    else if (firstSeenMs != null) deployedAtMs = firstSeenMs;
    else if (dex?.pairCreatedAt != null && Number.isFinite(dex.pairCreatedAt) && dex.pairCreatedAt > 0) {
      deployedAtMs = dex.pairCreatedAt;
    }
    return {
      buys5m: Number(buys5m),
      buys1h: Number(buys1h),
      holderCount,
      marketCap,
      deployedAtMs,
    };
  } catch {
    return null;
  }
}

function normalizeAddress(addr) {
  if (!addr || typeof addr !== "string") return null;
  const s = addr.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(s)) return null;
  return s.toLowerCase();
}

/** Normalize Ponder/indexer timestamps (unix seconds, ms, BigInt string, or ISO). */
function ponderTimestampToMs(v) {
  if (v == null) return null;
  if (typeof v === "bigint") {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : null;
  }
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return v < 1e12 ? v * 1000 : v;
  }
  if (typeof v === "string" && /^\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : null;
  }
  const t = new Date(v).getTime();
  return Number.isFinite(t) && t > 0 ? t : null;
}

async function fetchBankrLaunch(tokenAddress, apiKey = BANKR_API_KEY) {
  const urls = [
    `${BANKR_LAUNCH_URL}/${tokenAddress}`,
    `${BANKR_LAUNCH_URL}/${tokenAddress.slice(0, 2) + tokenAddress.slice(2).toUpperCase()}`,
  ];
  const headers = { Accept: "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const json = await res.json();
      const launch = json.launch ?? null;
      if (launch) return launch;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Fetch Bankr agent profile (weeklyRevenueWeth, marketCapUsd, etc.).
 * GET /agent-profiles/{token_address} — used for enrichment when indexer is slow or down.
 */
async function fetchBankrAgentProfile(tokenAddress, apiKey = BANKR_API_KEY) {
  const addr = tokenAddress?.trim?.()?.toLowerCase?.();
  if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) return null;
  const headers = { Accept: "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;
  try {
    const res = await fetch(`${BANKR_AGENT_PROFILES_URL}/${addr}`, { headers });
    if (!res.ok) return null;
    const json = await res.json();
    if (json && (json.weeklyRevenueWeth != null || json.marketCapUsd != null)) return json;
  } catch {
    /* ignore */
  }
  return null;
}

async function fetchDopplerTokenVolume(tokenAddress) {
  const base = DOPPLER_INDEXER_URL.replace(/\/$/, "");

  // 1) GraphQL: try common id formats (chainId-address, address)
  const query = `
    query Token($id: String!) {
      token(id: $id) {
        address name symbol volumeUsd holderCount firstSeenAt
        pool { address createdAt }
      }
    }
  `;
  const ids = [`${CHAIN_ID}-${tokenAddress}`, tokenAddress, `base-${tokenAddress}`];
  for (const id of ids) {
    try {
      const res = await fetch(`${base}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { id } }),
      });
      if (!res.ok) continue;
      const json = await res.json();
      if (json.errors?.length) continue;
      const token = json.data?.token;
      if (token) return token;
    } catch {
      /* try next id */
    }
  }

  // 2) GraphQL list with filter (Ponder/Doppler: tokens where address + chainId)
  // Inline values: some indexers don't support variables inside where
  const addrEscaped = tokenAddress.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const listQuery = `query { tokens(where: { chainId: ${CHAIN_ID}, address: "${addrEscaped}" }, limit: 1) { items { address name symbol volumeUsd holderCount firstSeenAt pool { address createdAt } } } }`;
  try {
    const res = await fetch(`${base}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: listQuery }),
    });
    if (res.ok) {
      const json = await res.json();
      if (!json.errors?.length) {
        const items = json.data?.tokens?.items ?? [];
        if (items.length > 0) return items[0];
      }
    }
  } catch {
    /* ignore */
  }

  // 3) REST search fallback: GET /search/:address?chain_ids=...
  try {
    const url = `${base}/search/${encodeURIComponent(tokenAddress)}?chain_ids=${CHAIN_ID}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    const items = Array.isArray(data) ? data : data?.items ?? data?.results ?? [];
    const match = items.find(
      (t) => (t.address ?? t.id ?? "").toLowerCase() === tokenAddress
    );
    if (match && (match.volumeUsd != null || match.volume != null)) {
      return {
        address: match.address ?? match.id,
        name: match.name,
        symbol: match.symbol,
        volumeUsd: match.volumeUsd ?? match.volume,
        holderCount: match.holderCount,
        firstSeenAt: match.firstSeenAt ?? match.first_seen_at ?? null,
        pool: match.pool,
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Step 1: Find pool by base token (asset).
 * Tries: pools(where: { baseToken, chainId }) then v4pools(where: { baseToken, chainId }) (Doppler indexer uses v4pools + poolId).
 * Then Step 2: cumulatedFees / cumulatedFee(poolId, chainId, beneficiary) { token0Fees, token1Fees, totalFeesUsd }
 */
async function fetchPoolByBaseToken(tokenAddress) {
  const base = DOPPLER_INDEXER_URL.replace(/\/$/, "");
  const addr = tokenAddress.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const addrLower = tokenAddress.toLowerCase();

  // 1) Prefer v4pools first — returns poolId (bytes32), which cumulatedFees and on-chain hook expect
  const v4Query = `query GetV4Pools { v4pools(where: { baseToken: "${addr}", chainId: ${CHAIN_ID} }, limit: 1) { items { poolId } } }`;
  try {
    const res = await fetch(`${base}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: v4Query }),
    });
    if (res.ok) {
      const json = await res.json();
      if (!json.errors?.length) {
        const items = json.data?.v4pools?.items ?? [];
        const pool = items[0];
        if (pool?.poolId) return { address: pool.poolId, id: pool.poolId };
      }
    }
  } catch {
    /* fallback */
  }

  // 1b) v4pools with baseToken as relation (some indexers use baseToken: { address: "0x..." })
  const v4QueryRel = `query GetV4PoolsRel { v4pools(where: { baseToken: { address: "${addr}" }, chainId: ${CHAIN_ID} }, limit: 1) { items { poolId } } }`;
  try {
    const res = await fetch(`${base}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: v4QueryRel }),
    });
    if (res.ok) {
      const json = await res.json();
      if (!json.errors?.length) {
        const items = json.data?.v4pools?.items ?? [];
        const pool = items[0];
        if (pool?.poolId) return { address: pool.poolId, id: pool.poolId };
      }
    }
  } catch {
    /* fallback */
  }

  // 2) Try pools (generic shape) — may return 40-char address; cumulatedFees may still accept it on some indexers
  const exactQuery = `query GetPools { pools(where: { baseToken: "${addr}", chainId: ${CHAIN_ID} }) { address } }`;
  try {
    const res = await fetch(`${base}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: exactQuery }),
    });
    if (res.ok) {
      const json = await res.json();
      if (!json.errors?.length) {
        const pools = json.data?.pools;
        const list = Array.isArray(pools) ? pools : pools?.items ?? [];
        const pool = list[0];
        if (pool?.address) return { address: pool.address, id: pool.address };
      }
    }
  } catch {
    /* fallback */
  }

  // 3) Other fallbacks (pools with items, or v4pools with baseToken filter)
  const fallbacks = [
    `query { pools(where: { baseToken: "${addr}", chainId: ${CHAIN_ID} }, limit: 1) { items { address id } } }`,
    `query { pools(where: { chainId: ${CHAIN_ID} }, limit: 50) { items { address id baseToken { address } } } }`,
    `query { v4pools(where: { chainId: ${CHAIN_ID} }, limit: 100) { items { poolId baseToken } } }`,
  ];
  for (const query of fallbacks) {
    try {
      const res = await fetch(`${base}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) continue;
      const json = await res.json();
      if (json.errors?.length) continue;
      const poolItems = json.data?.pools?.items ?? json.data?.pools ?? [];
      const v4Items = json.data?.v4pools?.items ?? [];
      const pool = poolItems.find(
        (p) => (p.baseToken?.address ?? p.baseToken ?? "").toLowerCase() === addrLower
      ) ?? poolItems[0];
      const v4Pool = v4Items.find(
        (p) => (p.baseToken ?? "").toLowerCase() === addrLower
      ) ?? v4Items[0];
      if (pool) return { address: pool.address ?? pool.id, id: pool.id ?? pool.address };
      if (v4Pool?.poolId) return { address: v4Pool.poolId, id: v4Pool.poolId };
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * Step 2: Cumulated fees for a beneficiary. Uses pool id from step 1.
 * Tries: cumulatedFees (plural/alias) then cumulatedFee (Ponder singular find-by-pk).
 * beneficiary: fee recipient wallet from launch (creator).
 */
async function fetchCumulatedFees(poolIdOrAddress, beneficiaryAddress) {
  const base = DOPPLER_INDEXER_URL.replace(/\/$/, "");
  // Try original beneficiary first (indexer may store EIP-55 checksum); then try lowercase.
  const beneficiariesToTry = [];
  if (beneficiaryAddress && typeof beneficiaryAddress === "string") {
    const trimmed = beneficiaryAddress.trim();
    if (trimmed) {
      beneficiariesToTry.push(trimmed);
      const lower = trimmed.toLowerCase();
      if (lower !== trimmed) beneficiariesToTry.push(lower);
    }
  }
  if (beneficiariesToTry.length === 0) return null;
  if (process.env.DEBUG_FEES === "1") {
    console.error("[DEBUG_FEES fetchCumulatedFees]", { poolIdOrAddress, beneficiaryAddress, beneficiariesToTry, base });
  }

  for (const beneficiary of beneficiariesToTry) {
    const vars = {
      poolId: poolIdOrAddress,
      chainId: CHAIN_ID,
      beneficiary,
    };
  // Try Int first, then Float (indexer-prod.doppler.lol uses Float! for chainId)
  const queryInt = `
    query GetFees($poolId: String!, $chainId: Int!, $beneficiary: String!) {
      cumulatedFees(poolId: $poolId, chainId: $chainId, beneficiary: $beneficiary) {
        token0Fees
        token1Fees
        totalFeesUsd
      }
    }
  `;
  const queryFloat = `
    query GetFees($poolId: String!, $chainId: Float!, $beneficiary: String!) {
      cumulatedFees(poolId: $poolId, chainId: $chainId, beneficiary: $beneficiary) {
        token0Fees
        token1Fees
        totalFeesUsd
      }
    }
  `;
  for (const query of [queryInt, queryFloat]) {
    try {
      const res = await fetch(`${base}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: vars }),
      });
      const json = await res.json().catch(() => ({}));
      if (process.env.DEBUG_FEES === "1" && (beneficiary === beneficiariesToTry[0] && query === queryInt)) {
        console.error("[DEBUG_FEES cumulatedFees]", { status: res.status, ok: res.ok, errors: json.errors, data: json.data });
      }
      if (!res.ok) continue;
      if (json.errors?.length) continue;
      const out = json.data?.cumulatedFees ?? null;
      if (out && (out.token0Fees != null || out.token1Fees != null || out.totalFeesUsd != null)) return out;
    } catch (e) {
      if (process.env.DEBUG_FEES === "1" && beneficiary === beneficiariesToTry[0] && query === queryInt) {
        console.error("[DEBUG_FEES cumulatedFees catch]", e.message);
      }
      /* try next */
    }
  }
  // Ponder singular find-by-primary-key: cumulatedFee(poolId, chainId, beneficiary)
  const querySingular = `
    query GetFee($poolId: String!, $chainId: Int!, $beneficiary: String!) {
      cumulatedFee(poolId: $poolId, chainId: $chainId, beneficiary: $beneficiary) {
        token0Fees
        token1Fees
        totalFeesUsd
      }
    }
  `;
  try {
    const res = await fetch(`${base}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: querySingular, variables: vars }),
    });
    if (!res.ok) continue;
    const json = await res.json();
    if (json.errors?.length) continue;
    const fromSingular = json.data?.cumulatedFee ?? null;
    if (fromSingular != null) return fromSingular;
  } catch {
    /* try next beneficiary */
  }
  // Ponder plural with where: cumulatedFees(where: { poolId, chainId, beneficiary }, limit: 1) { items { ... } }
  const queryWhere = `
    query GetFeesWhere($poolId: String!, $chainId: Int!, $beneficiary: String!) {
      cumulatedFees(where: { poolId: $poolId, chainId: $chainId, beneficiary: $beneficiary }, limit: 1) {
        items { token0Fees token1Fees totalFeesUsd }
      }
    }
  `;
  try {
    const res = await fetch(`${base}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: queryWhere, variables: vars }),
    });
    if (!res.ok) continue;
    const json = await res.json();
    if (json.errors?.length) continue;
    const items = json.data?.cumulatedFees?.items ?? [];
    const item = items[0] ?? null;
    if (item != null) return item;
  } catch {
    /* try next beneficiary */
  }
  }
  return null;
}

const POOL_STATE_TIMEOUT_MS = 8_000;

/**
 * Resolve bytes32 poolId for a token via Doppler SDK (getMulticurvePool).
 * Used when launch/indexer don't provide a 64-char poolId, so hook reads and Release events work.
 * @param {string} tokenAddress - Token contract address (0x...).
 * @returns {Promise<string|null>} bytes32 poolId or null.
 */
async function fetchPoolIdFromDopplerSdk(tokenAddress) {
  if (!tokenAddress || typeof tokenAddress !== "string" || !/^0x[a-fA-F0-9]{40}$/i.test(tokenAddress.trim())) return null;
  if (CHAIN_ID !== 8453) return null;
  const run = async () => {
    try {
      const [viem, chains] = await Promise.all([import("viem"), import("viem/chains")]);
      const chain = chains.base?.id === CHAIN_ID ? chains.base : { id: CHAIN_ID, name: "Base", nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" }, rpcUrls: { default: { http: ["https://mainnet.base.org"] } } };
      const publicClient = viem.createPublicClient({
        chain,
        transport: viem.http(getBaseRpcUrl()),
      });
      const { DopplerSDK } = await import("@whetstone-research/doppler-sdk");
      const sdk = new DopplerSDK({ publicClient, walletClient: undefined, chainId: CHAIN_ID });
      const pool = await sdk.getMulticurvePool(tokenAddress.trim());
      const id = pool?.poolId ?? pool?.id;
      if (id && typeof id === "string" && /^0x[a-fA-F0-9]{64}$/.test(id.trim())) return id.trim();
      return null;
    } catch {
      return null;
    }
  };
  try {
    return await Promise.race([
      run(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), POOL_STATE_TIMEOUT_MS)),
    ]);
  } catch {
    return null;
  }
}

/** Optional: fetch pool state (fee tier, status) via Doppler SDK read-only getState(). Times out so script never hangs. */
async function fetchDopplerPoolState(tokenAddress) {
  const run = async () => {
    try {
      const [viem, chains] = await Promise.all([
        import("viem"),
        import("viem/chains"),
      ]);
      const chain =
        chains.base?.id === CHAIN_ID
          ? chains.base
          : chains.baseSepolia?.id === CHAIN_ID
            ? chains.baseSepolia
            : { id: CHAIN_ID, name: "Unknown", nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" }, rpcUrls: { default: { http: [] } } };
      const publicClient = viem.createPublicClient({
        chain,
        transport: viem.http(getBaseRpcUrl()),
      });
      const { DopplerSDK } = await import("@whetstone-research/doppler-sdk");
      const sdk = new DopplerSDK({
        publicClient,
        walletClient: undefined,
        chainId: CHAIN_ID,
      });
      const pool = await sdk.getMulticurvePool(tokenAddress);
      const state = await pool.getState();
      return state;
    } catch {
      return null;
    }
  };
  try {
    return await Promise.race([
      run(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), POOL_STATE_TIMEOUT_MS)
      ),
    ]);
  } catch {
    return null;
  }
}

function formatUsd(value) {
  if (value == null || value === "" || Number.isNaN(Number(value))) return null;
  const n = Number(value);
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

export { fetchPoolByBaseToken, fetchCumulatedFees, fetchHookFeesOnChain, formatUsd, CHAIN_ID, DOPPLER_INDEXER_URL };

/** Event signature for claim transactions on RehypeDopplerHook (recipient + asset/token). If the contract uses a different event, getLogs returns []. */
const CLAIMED_FEES_EVENT = parseAbiItem(
  "event ClaimedFees(address indexed recipient, address indexed asset, uint256 tokenAmount, uint256 wethAmount)"
);

/** Release(poolId, beneficiary, fees0, fees1) from DecayMulticurveInitializer — actual event used when fee recipient claims on Base. fees0 = WETH, fees1 = token. */
const RELEASE_EVENT = parseAbiItem(
  "event Release(bytes32 indexed poolId, address indexed beneficiary, uint256 fees0, uint256 fees1)"
);

/**
 * Get total claimed fees from on-chain events so status is not just accrued − claimable.
 * Queries (1) RehypeDopplerHook.ClaimedFees(recipient, asset) and (2) when poolId is provided,
 * DecayMulticurveInitializer.Release(poolId, beneficiary) — which is what Base claim txns emit.
 * @param {string} feeWallet - Fee recipient address (0x...).
 * @param {string} tokenAddress - Pool asset / token address (0x...).
 * @param {string} [poolId] - Optional bytes32 pool id (0x...64 hex). When provided, also queries Release events from DecayMulticurveInitializer.
 * @returns {Promise<{ claimedToken: number, claimedWeth: number, count: number }>}
 */
export async function getClaimedFeesFromEvents(feeWallet, tokenAddress, poolId) {
  const recipient = normalizeAddress(feeWallet);
  const asset = normalizeAddress(tokenAddress);
  if (!recipient || !asset || CHAIN_ID !== 8453) return { claimedToken: 0, claimedWeth: 0, count: 0 };
  // Normalize to lowercase so getLogs topic filter matches on-chain (indexed bytes32)
  const poolIdTrimmed =
    poolId && typeof poolId === "string" && /^0x[a-fA-F0-9]{64}$/.test(poolId.trim())
      ? poolId.trim().toLowerCase()
      : null;

  try {
    const [viem, chains] = await Promise.all([import("viem"), import("viem/chains")]);
    const chain = chains.base?.id === CHAIN_ID ? chains.base : { id: CHAIN_ID, name: "Base", nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" }, rpcUrls: { default: { http: ["https://mainnet.base.org"] } } };
    const publicClient = viem.createPublicClient({
      chain,
      transport: viem.http(getBaseRpcUrl()),
    });
    const DECIMALS = 18;
    let claimedToken = 0n;
    let claimedWeth = 0n;
    let count = 0;

    // (1) RehypeDopplerHook — ClaimedFees(recipient, asset, tokenAmount, wethAmount)
    const hookAddress = DOPPLER_CONTRACTS_BASE.RehypeDopplerHook;
    const logsRehype = await publicClient.getLogs({
      address: hookAddress,
      event: CLAIMED_FEES_EVENT,
      args: { recipient, asset },
      fromBlock: 0n,
      toBlock: "latest",
    });
    for (const log of logsRehype) {
      const args = log.args;
      if (args?.tokenAmount != null) claimedToken += BigInt(args.tokenAmount);
      if (args?.wethAmount != null) claimedWeth += BigInt(args.wethAmount);
      count += 1;
    }

    // (2) DecayMulticurveInitializer — Release(poolId, beneficiary, fees0, fees1); fees0 = WETH, fees1 = token
    if (poolIdTrimmed) {
      const decayAddress = DOPPLER_CONTRACTS_BASE.DecayMulticurveInitializer;
      let logsRelease = await publicClient.getLogs({
        address: decayAddress,
        event: RELEASE_EVENT,
        args: { poolId: poolIdTrimmed, beneficiary: recipient },
        fromBlock: 0n,
        toBlock: "latest",
      });
      // Fallback: some RPCs don't match args filter; fetch by poolId only and filter beneficiary in code
      if (logsRelease.length === 0) {
        logsRelease = await publicClient.getLogs({
          address: decayAddress,
          event: RELEASE_EVENT,
          args: { poolId: poolIdTrimmed },
          fromBlock: 0n,
          toBlock: "latest",
        });
        logsRelease = logsRelease.filter(
          (log) => log.args?.beneficiary && String(log.args.beneficiary).toLowerCase() === recipient
        );
      }
      for (const log of logsRelease) {
        const args = log.args;
        if (args?.fees0 != null) claimedWeth += BigInt(args.fees0);
        if (args?.fees1 != null) claimedToken += BigInt(args.fees1);
        count += 1;
      }
    }

    return {
      claimedToken: Number(claimedToken) / 10 ** DECIMALS,
      claimedWeth: Number(claimedWeth) / 10 ** DECIMALS,
      count,
    };
  } catch {
    return { claimedToken: 0, claimedWeth: 0, count: 0 };
  }
}

/**
 * Check if a wallet has ever claimed fees for a pool (on-chain Release/ClaimedFees events).
 * Use this to verify "has this person collected fees for this pool?" (e.g. Basescan claim tx).
 * @param {string} wallet - Fee recipient / beneficiary address (0x...).
 * @param {string} tokenAddress - Pool asset / token address (0x...).
 * @param {string} [poolId] - Optional bytes32 pool id (0x...64 hex). Improves accuracy on Base.
 * @returns {Promise<boolean>}
 */
export async function hasWalletClaimedForPool(wallet, tokenAddress, poolId) {
  const r = await getClaimedFeesFromEvents(wallet, tokenAddress, poolId);
  return r.count > 0;
}

/** ERC-20 Transfer topic: Transfer(address indexed from, address indexed to, uint256 value). Events are emitted by token contracts; from = fee locker when locker sends to wallet. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Detect fee claims via ERC-20 Transfer logs: from = fee locker, to = wallet. Zero external API cost; uses RPC getLogs.
 * Use when Release/ClaimedFees events are missing or RPC doesn't index them. One subscription-style check.
 * @param {string} wallet - Fee recipient address (0x...).
 * @returns {Promise<{ count: number, latestTxHash: string | null }>}
 */
export async function getClaimedViaTransferLogs(wallet) {
  const recipient = normalizeAddress(wallet);
  if (!recipient || CHAIN_ID !== 8453) return { count: 0, latestTxHash: null };
  const lockers = [
    DOPPLER_CONTRACTS_BASE.DecayMulticurveInitializer,
    DOPPLER_CONTRACTS_BASE.RehypeDopplerHook,
  ].map((a) => a.toLowerCase());
  try {
    const [viem, chains] = await Promise.all([import("viem"), import("viem/chains")]);
    const chain = chains.base?.id === CHAIN_ID ? chains.base : { id: CHAIN_ID, name: "Base", nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" }, rpcUrls: { default: { http: ["https://mainnet.base.org"] } } };
    const publicClient = viem.createPublicClient({
      chain,
      transport: viem.http(getBaseRpcUrl()),
    });
    const pad = (addr) => viem.zeroPadValue(addr, 32);
    const allLogs = [];
    for (const locker of lockers) {
      const logs = await publicClient.getLogs({
        fromBlock: 0n,
        toBlock: "latest",
        topics: [TRANSFER_TOPIC, pad(locker), pad(recipient)],
      });
      allLogs.push(...logs);
    }
    if (allLogs.length === 0) return { count: 0, latestTxHash: null };
    const byBlock = [...allLogs].sort((a, b) => Number((b.blockNumber ?? 0n) - (a.blockNumber ?? 0n)));
    const latest = byBlock[0];
    return { count: allLogs.length, latestTxHash: latest?.transactionHash ?? null };
  } catch {
    return { count: 0, latestTxHash: null };
  }
}

/** On-chain read of RehypeDopplerHook.getHookFees(poolId). Requires RPC_URL_BASE (Base RPC).
 * @returns {{ hookFees: object|null, error: string|null }}
 */
async function fetchHookFeesOnChain(poolId) {
  if (!poolId || typeof poolId !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(poolId.trim())) return { hookFees: null, error: "invalid_pool_id" };
  if (CHAIN_ID !== 8453) return { hookFees: null, error: "chain_not_base" };
  try {
    const [viem, chains] = await Promise.all([import("viem"), import("viem/chains")]);
    const chain = chains.base?.id === CHAIN_ID ? chains.base : { id: CHAIN_ID, name: "Base", nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" }, rpcUrls: { default: { http: ["https://mainnet.base.org"] } } };
    const publicClient = viem.createPublicClient({
      chain,
      transport: viem.http(getBaseRpcUrl()),
    });
    const { getAddresses } = await import("@whetstone-research/doppler-sdk");
    const { rehypeDopplerHookAbi } = await import("@whetstone-research/doppler-sdk");
    const addresses = getAddresses(CHAIN_ID);
    const hookAddress = addresses?.rehypeDopplerHook ?? (CHAIN_ID === 8453 ? DOPPLER_CONTRACTS_BASE.RehypeDopplerHook : null);
    if (!hookAddress) return { hookFees: null, error: "no_hook_address" };
    const result = await publicClient.readContract({
      address: hookAddress,
      abi: rehypeDopplerHookAbi,
      functionName: "getHookFees",
      args: [poolId.trim()],
    });
    // viem may return object (named outputs) or array [fees0, fees1, beneficiaryFees0, beneficiaryFees1, customFee]
    const r = result;
    const b0 = r?.beneficiaryFees0 ?? (Array.isArray(r) ? r[2] : undefined);
    const b1 = r?.beneficiaryFees1 ?? (Array.isArray(r) ? r[3] : undefined);
    const f0 = r?.fees0 ?? (Array.isArray(r) ? r[0] : undefined);
    const f1 = r?.fees1 ?? (Array.isArray(r) ? r[1] : undefined);
    if (r && (b0 != null || b1 != null)) {
      return {
        hookFees: {
          beneficiaryFees0: b0 != null ? BigInt(b0) : 0n,
          beneficiaryFees1: b1 != null ? BigInt(b1) : 0n,
          fees0: f0 != null ? BigInt(f0) : 0n,
          fees1: f1 != null ? BigInt(f1) : 0n,
        },
        error: null,
      };
    }
    return { hookFees: null, error: "unexpected_contract_response" };
  } catch (e) {
    const msg = (e?.message ?? String(e)).slice(0, 200);
    return { hookFees: null, error: `rpc_or_contract: ${msg}` };
  }
}

const CREATOR_SHARE_BPS = 5700;
const SWAP_FEE_BPS = 120;

/**
 * Get fee-relevant data for one Bankr token (for Discord /fees-token or CLI).
 * @param {string} tokenAddress - Normalized 0x address.
 * @param {{ bankrApiKey?: string }} [options] - Optional. bankrApiKey overrides env (e.g. from Discord /setup).
 * @returns {Promise<{ tokenAddress: string, name: string, symbol: string, launch: object|null, feeRecipient: object|null, feeWallet: string|null, cumulatedFees: object|null, volumeUsd: string|null, estimatedCreatorFeesUsd: number|null, formatUsd: function, error?: string }>}
 */
export async function getTokenFees(tokenAddress, options = {}) {
  const addr = normalizeAddress(tokenAddress);
  if (!addr) return { tokenAddress: "", name: "—", symbol: "—", launch: null, feeRecipient: null, feeWallet: null, cumulatedFees: null, volumeUsd: null, estimatedCreatorFeesUsd: null, formatUsd, error: "Invalid token address (0x + 40 hex)." };

  const apiKey = options.bankrApiKey ?? BANKR_API_KEY;
  const [launch, doppler, poolState, dexMetrics, agentProfile] = await Promise.all([
    fetchBankrLaunch(addr, apiKey),
    fetchDopplerTokenVolume(addr),
    fetchDopplerPoolState(addr),
    fetchDexScreenerBaseToken(addr),
    fetchBankrAgentProfile(addr, apiKey),
  ]);

  const name = launch?.tokenName ?? doppler?.name ?? "—";
  const symbol = launch?.tokenSymbol ?? doppler?.symbol ?? "—";
  const volumeUsd = doppler?.volumeUsd != null ? String(doppler.volumeUsd) : null;
  const firstSeenAt =
    doppler?.firstSeenAt != null
      ? typeof doppler.firstSeenAt === "number"
        ? doppler.firstSeenAt
        : Math.floor(new Date(doppler.firstSeenAt).getTime() / 1000)
      : null;
  const volumeNum = volumeUsd != null ? Number(volumeUsd) : NaN;
  const estimatedCreatorFeesUsd = !Number.isNaN(volumeNum) && volumeNum >= 0
    ? (volumeNum * (SWAP_FEE_BPS / 10000) * (CREATOR_SHARE_BPS / 10000))
    : null;

  if (!launch) {
    return { tokenAddress: addr, name, symbol, launch: null, feeRecipient: null, feeWallet: null, cumulatedFees: null, volumeUsd, estimatedCreatorFeesUsd, formatUsd, dexMetrics, error: "No Bankr launch found for this address." };
  }

  const fee = launch.feeRecipient;
  const feeWallet =
    (fee?.walletAddress ? normalizeAddress(fee.walletAddress) : null) ??
    (fee?.wallet ?? fee?.address ? normalizeAddress(fee.wallet ?? fee.address) : null) ??
    (typeof launch.feeRecipientWallet === "string" && /^0x[a-fA-F0-9]{40}$/.test(launch.feeRecipientWallet.trim()) ? normalizeAddress(launch.feeRecipientWallet) : null) ??
    (typeof launch.creatorWallet === "string" && /^0x[a-fA-F0-9]{40}$/.test(launch.creatorWallet.trim()) ? normalizeAddress(launch.creatorWallet) : null) ??
    (launch.creator?.walletAddress ?? launch.creator?.wallet ? normalizeAddress(launch.creator.walletAddress ?? launch.creator.wallet) : null);
  let cumulatedFees = null;
  // Prefer launch.poolId (bytes32) when available — indexer expects this format for cumulatedFees.
  const poolIdFromLaunch =
    (typeof launch.poolId === "string" && /^0x[a-fA-F0-9]{64}$/.test(launch.poolId.trim()) ? launch.poolId.trim() : null) ??
    (launch.pool && typeof launch.pool === "string" && /^0x[a-fA-F0-9]{64}$/.test(launch.pool.trim()) ? launch.pool.trim() : null) ??
    (launch.pool?.poolId && typeof launch.pool.poolId === "string" && /^0x[a-fA-F0-9]{64}$/.test(launch.pool.poolId.trim()) ? launch.pool.poolId.trim() : null);
  // Resolve poolId: run indexer and on-chain SDK in parallel so Claimable/Claims work when indexer is down
  const [poolFromIndexer, sdkPoolId] = await Promise.all([
    poolIdFromLaunch ? Promise.resolve(null) : fetchPoolByBaseToken(addr),
    CHAIN_ID === 8453 ? fetchPoolIdFromDopplerSdk(addr) : Promise.resolve(null),
  ]);
  const effectivePoolId = poolIdFromLaunch ?? poolFromIndexer?.id ?? poolFromIndexer?.address;
  if (effectivePoolId && feeWallet) {
    // Only query fees for the fee recipient (creator). We show what they could claim or have accrued.
    cumulatedFees = await fetchCumulatedFees(effectivePoolId, feeWallet);
  }
  if (process.env.DEBUG_FEES === "1") {
    console.error("[DEBUG_FEES]", addr, {
      poolIdFromLaunch: poolIdFromLaunch ?? null,
      poolFromIndexer: poolFromIndexer ? { id: poolFromIndexer.id, address: poolFromIndexer.address } : null,
      effectivePoolId: effectivePoolId ?? null,
      feeWallet: feeWallet ?? null,
      hasCumulatedFees: !!cumulatedFees,
    });
  }

  let hookFees = null;
  // Prefer on-chain poolId (SDK) for hook and Release events so Claimable/Claims work when indexer is down
  const effectivePoolIdBytes32 = effectivePoolId && /^0x[a-fA-F0-9]{64}$/.test(String(effectivePoolId).trim()) ? String(effectivePoolId).trim() : null;
  const poolIdForHook = sdkPoolId ?? effectivePoolIdBytes32;
  let claimableUnavailableReason = null;
  if (poolIdForHook) {
    const hookResult = await fetchHookFeesOnChain(poolIdForHook);
    hookFees = hookResult.hookFees;
    if (hookResult.error) claimableUnavailableReason = hookResult.error;
  } else {
    claimableUnavailableReason = "no_pool_id";
  }

  let claimedFromEvents = null;
  let lastClaimTxHash = null;
  if (feeWallet && addr) {
    const ev = await getClaimedFeesFromEvents(feeWallet, addr, poolIdForHook ?? undefined);
    claimedFromEvents = { claimedToken: ev.claimedToken, claimedWeth: ev.claimedWeth, count: ev.count };
    // Fallbacks when RPC Release/ClaimedFees events miss the claim (0 cost: RPC getLogs first, then BaseScan)
    if (ev.count === 0 && CHAIN_ID === 8453) {
      try {
        const transferLogs = await getClaimedViaTransferLogs(feeWallet);
        if (transferLogs.count > 0) {
          claimedFromEvents = { claimedToken: 0, claimedWeth: 0, count: transferLogs.count };
          lastClaimTxHash = transferLogs.latestTxHash ?? null;
        }
      } catch (_) {
        /* ignore */
      }
      if (claimedFromEvents?.count === 0) {
        try {
          const baseScan = await getClaimTxsFromBaseScan(feeWallet, undefined, { limit: 100 });
          if (baseScan.count > 0) {
            claimedFromEvents = { claimedToken: 0, claimedWeth: 0, count: baseScan.count };
            lastClaimTxHash = baseScan.latestTxHash ?? null;
          }
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  return {
    tokenAddress: addr,
    name,
    symbol,
    launch,
    feeRecipient: fee ?? null,
    feeWallet,
    cumulatedFees,
    hookFees,
    volumeUsd,
    estimatedCreatorFeesUsd,
    formatUsd,
    poolState,
    dexMetrics: dexMetrics ?? null,
    /** Bankr agent-profiles API: weeklyRevenueWeth, marketCapUsd, etc. (enrichment when indexer is slow) */
    agentProfile: agentProfile ?? null,
    /** True if we had a bytes32 poolId and could call the on-chain hook (even if hook returned zero). */
    hasPoolIdForHook: !!poolIdForHook,
    /** When claimable is unavailable: no_pool_id | rpc_or_contract: ... | etc. */
    claimableUnavailableReason: claimableUnavailableReason ?? null,
    /** Total claimed from on-chain ClaimedFees events (so status is not just accrued − claimable). */
    claimedFromEvents: claimedFromEvents ?? null,
    /** Latest claim tx hash when known (from RPC events or BaseScan fallback). For "View claim tx" link. */
    lastClaimTxHash: lastClaimTxHash ?? null,
    /** Unix timestamp (seconds) when token was first seen by indexer; for daily average. */
    firstSeenAt: firstSeenAt ?? null,
  };
}

async function main() {
  const raw = process.argv[2];
  const tokenAddress = normalizeAddress(raw);
  if (!tokenAddress) {
    console.log("Usage: node src/token-stats.js <tokenAddress>");
    console.log("Example: node src/token-stats.js 0x9b40e8d9dda89230ea0e034ae2ef0f435db57ba3");
    process.exit(1);
  }

  const out = await getTokenFees(tokenAddress);
  const { name, symbol, launch, feeRecipient: fee, cumulatedFees, hookFees, volumeUsd, estimatedCreatorFeesUsd, formatUsd: fmt, poolState } = out;
  const deployer = launch?.deployer;

  console.log(`\n  Token: ${name} ($${symbol})`);
  console.log(`  CA:    ${tokenAddress}`);
  console.log(`  Bankr: https://bankr.bot/launches/${tokenAddress}\n`);

  if (out.error || !launch) {
    console.log("  ", out.error ?? "No Bankr launch found.");
    if (volumeUsd) console.log(`  Indexer volume: ${fmt(volumeUsd) ?? "—"}`);
    return;
  }

  console.log("  Deployer:", deployer?.walletAddress ?? "—", deployer?.xUsername ? `@${deployer.xUsername}` : "");
  console.log("  Fee to: ", fee?.walletAddress ?? fee?.wallet ?? "—", fee?.xUsername ? `@${fee.xUsername}` : "");
  console.log("  Pool:   ", launch.poolId ?? "—");
  if (launch.tweetUrl) console.log("  Tweet:  ", launch.tweetUrl);
  if (poolState) {
    const statusNames = { 0: "Uninitialized", 1: "Initialized", 2: "Locked", 3: "Exited" };
    const status = statusNames[Number(poolState.status)] ?? `Status ${poolState.status}`;
    const feeBps = poolState.fee != null ? Number(poolState.fee) : null;
    console.log("  Pool state (Doppler SDK):", status, feeBps != null ? `| fee ${(feeBps / 10000).toFixed(2)}%` : "");
  }
  console.log("");

  if (cumulatedFees && (cumulatedFees.token0Fees != null || cumulatedFees.token1Fees != null || cumulatedFees.totalFeesUsd != null)) {
    console.log("  Cumulated fees (indexer) for fee recipient:");
    if (cumulatedFees.token0Fees != null) console.log("    token0:", cumulatedFees.token0Fees);
    if (cumulatedFees.token1Fees != null) console.log("    token1:", cumulatedFees.token1Fees);
    if (cumulatedFees.totalFeesUsd != null) console.log("    total (USD):", formatUsd(cumulatedFees.totalFeesUsd) ?? cumulatedFees.totalFeesUsd);
    console.log("");
  } else if (hookFees && (hookFees.beneficiaryFees0 > 0n || hookFees.beneficiaryFees1 > 0n)) {
    const dec = 18;
    console.log("  On-chain (Rehype hook) — beneficiary share:");
    if (hookFees.beneficiaryFees0 > 0n) console.log("    token:", Number(hookFees.beneficiaryFees0) / 10 ** dec);
    if (hookFees.beneficiaryFees1 > 0n) console.log("    WETH:", Number(hookFees.beneficiaryFees1) / 10 ** dec);
    console.log("");
  }

  if (volumeUsd != null) {
    console.log("  Trading volume (indexer):", fmt(volumeUsd) ?? "—");
    if (estimatedCreatorFeesUsd != null) {
      console.log("  Estimated creator fees (57% of 1.2% of volume):", fmt(estimatedCreatorFeesUsd));
    }
    if (Number(volumeUsd) === 0) {
      console.log("  (Indexer has no volume for this token yet — new or not yet indexed.)");
    }
    console.log("");
  } else {
    console.log("  Volume: not available (indexer may not have this token or use DOPPLER_INDEXER_URL for Base).");
    console.log("");
  }

  if (!cumulatedFees || (cumulatedFees.token0Fees == null && cumulatedFees.token1Fees == null && cumulatedFees.totalFeesUsd == null)) {
    console.log("  Claimable balance is also visible to the fee beneficiary via:");
    console.log("    bankr fees --token", tokenAddress);
    console.log("");
  }
}

// Only run main when this file is executed directly (e.g. npm run token-stats), not when imported by discord-bot/fees-for-wallet
const isRunDirectly = process.argv[1]?.includes("token-stats");
if (isRunDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
