/**
 * Doppler fee claim watcher — real-time detection via Alchemy WebSocket.
 * Listens for ERC20 Transfer(from = feeLocker, to = beneficiary) and emits claim events.
 * Only WETH transfers are treated as fee claims (pool init/launch sends other tokens; collectFees pays WETH).
 * No polling; uses eth_subscribe over WebSocket only.
 *
 * Env: ALCHEMY_KEY or ALCHEMY_WS_URL (Base mainnet). If unset, watcher does not start.
 */

import { EventEmitter } from "events";
import { createPublicClient, webSocket, parseAbiItem } from "viem";
import { base } from "viem/chains";
import { DOPPLER_CONTRACTS_BASE } from "../config.js";

const CHAIN_ID = parseInt(process.env.CHAIN_ID || "8453", 10);

/** WETH on Base. Only transfers of this token from the fee locker are real fee claims (collectFees); others are pool init. */
const WETH_BASE = "0x4200000000000000000000000000000000000006";

const FEE_LOCKERS =
  CHAIN_ID === 8453
    ? [
        DOPPLER_CONTRACTS_BASE.DecayMulticurveInitializer,
        DOPPLER_CONTRACTS_BASE.RehypeDopplerHook,
      ].map((a) => a.toLowerCase())
    : [];

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

const ERC20_ABI = [
  { inputs: [], name: "symbol", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
];

function getWsUrl() {
  const key = process.env.ALCHEMY_KEY || process.env.ALCHEMY_API_KEY;
  const url = process.env.ALCHEMY_WS_URL;
  if (url) return url;
  if (key && CHAIN_ID === 8453) return `wss://base-mainnet.g.alchemy.com/v2/${key}`;
  return null;
}

/**
 * Fetch symbol and decimals for an ERC20 (optional; best-effort).
 * @param {import('viem').PublicClient} client
 * @param {string} tokenAddress
 * @returns {Promise<{ symbol: string, decimals: number } | null>}
 */
async function getTokenMeta(client, tokenAddress) {
  try {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: "symbol" }),
      client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: "decimals" }),
    ]);
    return { symbol: symbol ?? "?", decimals: Number(decimals ?? 18) };
  } catch {
    return null;
  }
}

/**
 * @typedef {Object} FeeClaimPayload
 * @property {string} beneficiary - Wallet receiving tokens (0x...)
 * @property {string} token - ERC20 contract address
 * @property {string} amount - Raw value (wei) as string
 * @property {string} txHash - Transaction hash
 * @property {string} feeLocker - Locker address that sent the tokens
 * @property {string} [symbol] - Token symbol if fetched (e.g. "WETH")
 * @property {number} [decimals] - Token decimals if fetched
 * @property {string} [amountFormatted] - Human-readable amount (e.g. "5.93")
 */

/** @type {EventEmitter & { onFeeClaim(fn: (claim: FeeClaimPayload) => void): void; start(): Promise<void>; stop(): void }} */
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

let publicClient = null;
let unwatchers = [];
let running = false;
/** One alert per tx; avoids duplicate messages when one claim tx has multiple transfers. */
const recentTxHashes = new Set();
const RECENT_TX_MAX = 5000;

/**
 * Start the claim watcher. Subscribes to Transfer events from each fee locker.
 * Does nothing if ALCHEMY_KEY/ALCHEMY_WS_URL is unset or chain is not Base.
 */
async function start() {
  const wsUrl = getWsUrl();
  if (!wsUrl || FEE_LOCKERS.length === 0) {
    console.log("[dopplerClaimWatcher] Skipped: set ALCHEMY_KEY or ALCHEMY_WS_URL for Base to enable.");
    return;
  }
  if (running) return;
  try {
    publicClient = createPublicClient({
      chain: base,
      transport: webSocket(wsUrl, { reconnect: true }),
    });
    for (const locker of FEE_LOCKERS) {
      const unwatch = publicClient.watchEvent({
        event: TRANSFER_EVENT,
        args: { from: locker },
        poll: false,
        onLogs: async (logs) => {
          // Only WETH transfers = real fee claims; other tokens are pool init/launch distributions
          const wethLower = WETH_BASE.toLowerCase();
          for (const log of logs) {
            const tokenAddr = (log.address ?? "").toLowerCase();
            if (tokenAddr !== wethLower) continue;
            const value = log.args?.value ?? 0n;
            if (value === 0n) continue;
            const txHash = log.transactionHash ?? "";
            if (!txHash) continue;
            if (recentTxHashes.has(txHash)) continue;
            recentTxHashes.add(txHash);
            if (recentTxHashes.size > RECENT_TX_MAX) {
              const first = recentTxHashes.values().next().value;
              if (first) recentTxHashes.delete(first);
            }
            const payload = {
              beneficiary: (log.args?.to ?? "").toLowerCase(),
              token: tokenAddr,
              amount: String(value),
              txHash,
              feeLocker: (log.args?.from ?? locker).toLowerCase(),
              symbol: "WETH",
              decimals: 18,
              amountFormatted: (Number(value) / 1e18).toFixed(4),
            };
            emitter.emit("claim", payload);
          }
        },
        onError: (err) => {
          console.error("[dopplerClaimWatcher] subscription error:", err?.message ?? err);
        },
      });
      unwatchers.push(unwatch);
    }
    running = true;
    console.log("[dopplerClaimWatcher] Started: WETH transfers only from", FEE_LOCKERS.length, "locker(s) (real fee claims).");
  } catch (err) {
    console.error("[dopplerClaimWatcher] Failed to start:", err?.message ?? err);
  }
}

function stop() {
  for (const unwatch of unwatchers) {
    try {
      unwatch();
    } catch (_) {}
  }
  unwatchers = [];
  publicClient = null;
  running = false;
  console.log("[dopplerClaimWatcher] Stopped.");
}

/**
 * Register a listener for fee claim events.
 * @param {(claim: FeeClaimPayload) => void} fn
 */
function onFeeClaim(fn) {
  emitter.on("claim", fn);
}

export { start, stop, onFeeClaim, getWsUrl };
