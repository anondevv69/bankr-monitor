/**
 * Detect fee claims via BaseScan API when RPC getLogs or Doppler indexer don't have claim events.
 * Two signals (per ChatGPT):
 * 1) tx.from === beneficiary && tx.to === feeLocker → wallet called collectFees()
 * 2) ERC20 Transfer from === feeLocker to === beneficiary (handled via tokentx if needed)
 *
 * We use (1) here: list normal txs for the wallet, filter where to === known fee locker.
 * Env: BASESCAN_API_KEY (optional; recommended for rate limits)
 */

const CHAIN_ID = parseInt(process.env.CHAIN_ID || "8453", 10);
const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY || "";

const BASESCAN_API_BASE =
  CHAIN_ID === 8453 ? "https://api.basescan.org/api" : "https://api-sepolia.basescan.org/api";

/** Fee locker / claim contracts on Base. Wallet calls collectFees() on these. */
const FEE_LOCKER_ADDRESSES = [
  "0xd59ce43e53d69f190e15d9822fb4540dccc91178", // DecayMulticurveInitializer (Bankr claims)
  "0x97cad5684fb7cc2bed9a9b5ebfba67138f4f2503", // RehypeDopplerHook
].map((a) => a.toLowerCase());

/**
 * Fetch normal transactions for an address from BaseScan.
 * @param {string} wallet - 0x... address
 * @param {{ page?: number, offset?: number }} [opts]
 * @returns {Promise<Array<{ hash: string, to: string, blockNumber: string }>>}
 */
async function fetchAccountTxList(wallet, opts = {}) {
  const addr = typeof wallet === "string" ? wallet.trim() : "";
  if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) return [];
  const params = new URLSearchParams({
    module: "account",
    action: "txlist",
    address: addr,
    startblock: "0",
    endblock: "99999999",
    sort: "desc",
    ...(opts.page != null && { page: String(opts.page) }),
    ...(opts.offset != null && { offset: String(opts.offset) }),
    ...(BASESCAN_API_KEY && { apikey: BASESCAN_API_KEY }),
  });
  try {
    const res = await fetch(`${BASESCAN_API_BASE}?${params.toString()}`);
    const data = await res.json();
    if (data.status !== "1" || !Array.isArray(data.result)) return [];
    return data.result;
  } catch {
    return [];
  }
}

/**
 * Get claim-related txs: wallet sent tx to a fee locker (collectFees call).
 * @param {string} wallet - Fee recipient / beneficiary address (0x...).
 * @param {string[]} [feeLockers] - List of fee locker addresses (default: FEE_LOCKER_ADDRESSES).
 * @param {{ limit?: number }} [opts] - limit = max txs to fetch (default 100).
 * @returns {Promise<{ count: number, latestTxHash: string | null, latestBlock: number | null }>}
 */
export async function getClaimTxsFromBaseScan(wallet, feeLockers = FEE_LOCKER_ADDRESSES, opts = {}) {
  const limit = Math.min(1000, Math.max(1, opts.limit ?? 100));
  const lockers = (feeLockers || FEE_LOCKER_ADDRESSES).map((a) => String(a).toLowerCase());
  const set = new Set(lockers);
  const txs = await fetchAccountTxList(wallet, { offset: 0 });
  const claimTxs = txs.filter((tx) => tx.to && set.has(String(tx.to).toLowerCase())).slice(0, limit);
  const latest = claimTxs[0] ?? null;
  return {
    count: claimTxs.length,
    latestTxHash: latest?.hash ?? null,
    latestBlock: latest?.blockNumber != null ? parseInt(latest.blockNumber, 10) : null,
  };
}

/**
 * Check if a wallet has ever called a fee locker (claim) using BaseScan. Use when RPC/indexer show no claim events.
 * @param {string} wallet - Fee recipient address (0x...).
 * @returns {Promise<{ hasClaimed: boolean, latestTxHash: string | null }>}
 */
export async function hasWalletClaimedViaBaseScan(wallet) {
  if (CHAIN_ID !== 8453) return { hasClaimed: false, latestTxHash: null };
  const { count, latestTxHash } = await getClaimTxsFromBaseScan(wallet, undefined, { limit: 100 });
  return { hasClaimed: count > 0, latestTxHash };
}
