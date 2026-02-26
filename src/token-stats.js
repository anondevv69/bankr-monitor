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
 *      DOPPLER_INDEXER_URL (optional; for Base mainnet /fees the public indexer.doppler.lol is often down — use your own e.g. Railway)
 *      CHAIN_ID (default 8453)
 */

import "dotenv/config";

const CHAIN_ID = parseInt(process.env.CHAIN_ID || "8453", 10);
// Public Base mainnet indexer (indexer.doppler.lol) is often 502; for production set DOPPLER_INDEXER_URL to your own (e.g. Railway).
const DOPPLER_INDEXER_URL =
  process.env.DOPPLER_INDEXER_URL ||
  (CHAIN_ID === 8453 ? "https://indexer.doppler.lol" : "https://testnet-indexer.doppler.lol");
const BANKR_LAUNCH_URL = "https://api.bankr.bot/token-launches";
const BANKR_API_KEY = process.env.BANKR_API_KEY;

function normalizeAddress(addr) {
  if (!addr || typeof addr !== "string") return null;
  const s = addr.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(s)) return null;
  return s.toLowerCase();
}

async function fetchBankrLaunch(tokenAddress) {
  const urls = [
    `${BANKR_LAUNCH_URL}/${tokenAddress}`,
    `${BANKR_LAUNCH_URL}/${tokenAddress.slice(0, 2) + tokenAddress.slice(2).toUpperCase()}`,
  ];
  const headers = { Accept: "application/json" };
  if (BANKR_API_KEY) headers["X-API-Key"] = BANKR_API_KEY;
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

async function fetchDopplerTokenVolume(tokenAddress) {
  const base = DOPPLER_INDEXER_URL.replace(/\/$/, "");

  // 1) GraphQL: try common id formats (chainId-address, address)
  const query = `
    query Token($id: String!) {
      token(id: $id) {
        address name symbol volumeUsd holderCount
        pool { address }
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
  const listQuery = `query { tokens(where: { chainId: ${CHAIN_ID}, address: "${addrEscaped}" }, limit: 1) { items { address name symbol volumeUsd } } }`;
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

  // 1) Try pools (generic shape)
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

  // 2) Doppler indexer: v4pools(where: { baseToken, chainId }) { items { poolId } } — no "address", use poolId
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
    /* next */
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
  const vars = {
    poolId: poolIdOrAddress,
    chainId: CHAIN_ID,
    beneficiary: beneficiaryAddress,
  };
  // Plural or custom resolver: cumulatedFees(poolId, chainId, beneficiary)
  const queryPlural = `
    query GetFees($poolId: String!, $chainId: Int!, $beneficiary: String!) {
      cumulatedFees(poolId: $poolId, chainId: $chainId, beneficiary: $beneficiary) {
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
      body: JSON.stringify({ query: queryPlural, variables: vars }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.errors?.length) return null;
    const fromPlural = json.data?.cumulatedFees ?? null;
    if (fromPlural != null) return fromPlural;
  } catch {
    /* try singular */
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
    if (!res.ok) return null;
    const json = await res.json();
    if (json.errors?.length) return null;
    const fromSingular = json.data?.cumulatedFee ?? null;
    if (fromSingular != null) return fromSingular;
  } catch {
    /* try plural with where */
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
    if (!res.ok) return null;
    const json = await res.json();
    if (json.errors?.length) return null;
    const items = json.data?.cumulatedFees?.items ?? [];
    return items[0] ?? null;
  } catch {
    return null;
  }
}

const POOL_STATE_TIMEOUT_MS = 8_000;

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
        transport: viem.http(process.env.RPC_URL || undefined),
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

/** On-chain read of RehypeDopplerHook.getHookFees(poolId). Returns beneficiary share (token0, token1) or null. Requires RPC_URL for Base. */
async function fetchHookFeesOnChain(poolId) {
  if (!poolId || typeof poolId !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(poolId.trim())) return null;
  if (CHAIN_ID !== 8453) return null;
  try {
    const [viem, chains] = await Promise.all([import("viem"), import("viem/chains")]);
    const chain = chains.base?.id === CHAIN_ID ? chains.base : { id: CHAIN_ID, name: "Base", nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" }, rpcUrls: { default: { http: ["https://mainnet.base.org"] } } };
    const publicClient = viem.createPublicClient({
      chain,
      transport: viem.http(process.env.RPC_URL_BASE || process.env.RPC_URL || "https://mainnet.base.org"),
    });
    const { getAddresses } = await import("@whetstone-research/doppler-sdk");
    const { rehypeDopplerHookAbi } = await import("@whetstone-research/doppler-sdk");
    const addresses = getAddresses(CHAIN_ID);
    const hookAddress = addresses?.rehypeDopplerHook;
    if (!hookAddress) return null;
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
        beneficiaryFees0: b0 != null ? BigInt(b0) : 0n,
        beneficiaryFees1: b1 != null ? BigInt(b1) : 0n,
        fees0: f0 != null ? BigInt(f0) : 0n,
        fees1: f1 != null ? BigInt(f1) : 0n,
      };
    }
  } catch {
    /* not a Rehype pool or RPC failed */
  }
  return null;
}

const CREATOR_SHARE_BPS = 5700;
const SWAP_FEE_BPS = 120;

/**
 * Get fee-relevant data for one Bankr token (for Discord /fees-token or CLI).
 * @param {string} tokenAddress - Normalized 0x address.
 * @returns {Promise<{ tokenAddress: string, name: string, symbol: string, launch: object|null, feeRecipient: object|null, feeWallet: string|null, cumulatedFees: object|null, volumeUsd: string|null, estimatedCreatorFeesUsd: number|null, formatUsd: function, error?: string }>}
 */
export async function getTokenFees(tokenAddress) {
  const addr = normalizeAddress(tokenAddress);
  if (!addr) return { tokenAddress: "", name: "—", symbol: "—", launch: null, feeRecipient: null, feeWallet: null, cumulatedFees: null, volumeUsd: null, estimatedCreatorFeesUsd: null, formatUsd, error: "Invalid token address (0x + 40 hex)." };

  const [launch, doppler, poolState] = await Promise.all([
    fetchBankrLaunch(addr),
    fetchDopplerTokenVolume(addr),
    fetchDopplerPoolState(addr),
  ]);

  const name = launch?.tokenName ?? doppler?.name ?? "—";
  const symbol = launch?.tokenSymbol ?? doppler?.symbol ?? "—";
  const volumeUsd = doppler?.volumeUsd != null ? String(doppler.volumeUsd) : null;
  const volumeNum = volumeUsd != null ? Number(volumeUsd) : NaN;
  const estimatedCreatorFeesUsd = !Number.isNaN(volumeNum) && volumeNum >= 0
    ? (volumeNum * (SWAP_FEE_BPS / 10000) * (CREATOR_SHARE_BPS / 10000))
    : null;

  if (!launch) {
    return { tokenAddress: addr, name, symbol, launch: null, feeRecipient: null, feeWallet: null, cumulatedFees: null, volumeUsd, estimatedCreatorFeesUsd, formatUsd, error: "No Bankr launch found for this address." };
  }

  const fee = launch.feeRecipient;
  const feeWallet = fee?.walletAddress ? normalizeAddress(fee.walletAddress) : (fee?.wallet ?? fee?.address ? normalizeAddress(fee.wallet ?? fee.address) : null);
  let cumulatedFees = null;
  if (feeWallet) {
    const pool = await fetchPoolByBaseToken(addr);
    if (pool) {
      cumulatedFees = await fetchCumulatedFees(pool.id ?? pool.address, feeWallet);
    }
  }

  let hookFees = null;
  const poolId = typeof launch.poolId === "string" ? launch.poolId.trim() : null;
  if (poolId) {
    hookFees = await fetchHookFeesOnChain(poolId);
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
