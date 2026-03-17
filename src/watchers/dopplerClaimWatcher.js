/**
 * Doppler fee claim watcher — real-time detection via Alchemy WebSocket.
 * Listens for ERC20 Transfer(from = feeLocker, to = beneficiary) and emits claim events.
 * Only WETH transfers are treated as fee claims (pool init/launch sends other tokens; collectFees pays WETH).
 * No polling; uses eth_subscribe over WebSocket only.
 *
 * Env: ALCHEMY_KEY or ALCHEMY_WS_URL (Base mainnet). If unset, watcher does not start.
 */

import { EventEmitter } from "events";
import { createPublicClient, webSocket, parseAbiItem, decodeFunctionData } from "viem";
import { base } from "viem/chains";
import { DOPPLER_CONTRACTS_BASE } from "../config.js";

const CHAIN_ID = parseInt(process.env.CHAIN_ID || "8453", 10);

/** WETH on Base. Only transfers of this token from the fee locker are real fee claims (collectFees); others are pool init. */
const WETH_BASE = "0x4200000000000000000000000000000000000006";
/** Minimum WETH amount to count as a claim; filters dust, AA bundler artifacts, rounding. 0.0001 WETH. */
const MIN_WETH_CLAIM = 100000000000000n;

/** ERC-4337 EntryPoint (v0.6) on Base; handleOps(tuple[], beneficiary) — use ops[0].sender as claimer when tx goes through AA. */
const ENTRYPOINT_V06 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032".toLowerCase();

/** Only emit claims for pool tokens whose address ends with this (Bankr tokens end in "ba3"). Set BANKR_TOKEN_SUFFIX to override. */
const BANKR_TOKEN_SUFFIX = (process.env.BANKR_TOKEN_SUFFIX || "ba3").toLowerCase();

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

/** ERC-20 Transfer topic for parsing receipt logs. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** EntryPoint handleOps: (address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[], address — ops[0].sender is first field. */
const ENTRYPOINT_ABI_HANDLEOPS_LEGACY = [
  {
    inputs: [
      {
        components: [
          { name: "sender", type: "address" },
          { type: "uint256" },
          { type: "bytes" },
          { type: "bytes" },
          { type: "bytes32" },
          { type: "uint256" },
          { type: "bytes32" },
          { type: "bytes" },
          { type: "bytes" },
        ],
        name: "ops",
        type: "tuple[]",
      },
      { name: "beneficiary", type: "address" },
    ],
    name: "handleOps",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];
/** EntryPoint v0.6 handleOps — try if legacy decode fails. */
const ENTRYPOINT_ABI_V06 = [
  {
    inputs: [
      {
        components: [
          { name: "sender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "factory", type: "address" },
          { name: "factoryData", type: "bytes" },
          { name: "callData", type: "bytes" },
          { name: "callGasLimit", type: "uint256" },
          { name: "verificationGasLimit", type: "uint256" },
          { name: "preVerificationGas", type: "uint256" },
          { name: "maxFeePerGas", type: "uint256" },
          { name: "maxPriorityFeePerGas", type: "uint256" },
          { name: "paymaster", type: "address" },
          { name: "paymasterVerificationGasLimit", type: "uint256" },
          { name: "paymasterPostOpGasLimit", type: "uint256" },
          { name: "paymasterData", type: "bytes" },
          { name: "signature", type: "bytes" },
        ],
        name: "ops",
        type: "tuple[]",
      },
      { name: "beneficiary", type: "address" },
    ],
    name: "handleOps",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];

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

function getRpcUrl() {
  return process.env.RPC_URL_BASE || process.env.RPC_URL || "https://mainnet.base.org";
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
 * Resolve claimer (tx.from or ops[0].sender for handleOps) and pool token from same-tx logs.
 * @param {import('viem').PublicClient} client
 * @param {string} txHash
 * @param {string} feeLocker - Locker address (lowercase)
 * @returns {Promise<{ claimer: string, poolToken: string | null, poolSymbol: string | null }>}
 */
async function enrichClaim(client, txHash, feeLocker) {
  const out = { claimer: "", poolToken: null, poolSymbol: null };
  try {
    const [tx, receipt] = await Promise.all([
      client.getTransaction({ hash: txHash }),
      client.getTransactionReceipt({ hash: txHash }),
    ]);
    if (!tx) return out;
    out.claimer = (tx.from ?? "").toLowerCase();
    if (tx.input) {
      for (const abi of [ENTRYPOINT_ABI_HANDLEOPS_LEGACY, ENTRYPOINT_ABI_V06]) {
        try {
          const decoded = decodeFunctionData({ abi, data: tx.input });
          if (decoded.functionName === "handleOps" && decoded.args?.ops?.length > 0 && decoded.args.ops[0]?.sender) {
            out.claimer = String(decoded.args.ops[0].sender).toLowerCase();
            break;
          }
        } catch (_) {}
      }
    }
    if (!receipt?.logs?.length) return out;
    const wethLower = WETH_BASE.toLowerCase();
    const lockerPadded = "0x" + feeLocker.slice(2).toLowerCase().padStart(64, "0");
    for (const log of receipt.logs) {
      if (log.topics?.[0] !== TRANSFER_TOPIC) continue;
      const fromTopic = log.topics[1];
      if (!fromTopic || fromTopic.toLowerCase() !== lockerPadded) continue;
      const tokenAddr = (log.address ?? "").toLowerCase();
      if (tokenAddr === wethLower) continue;
      out.poolToken = tokenAddr;
      const meta = await getTokenMeta(client, tokenAddr);
      if (meta) out.poolSymbol = meta.symbol;
      break;
    }
  } catch (_) {}
  return out;
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
 * @property {string} [claimer] - Wallet that triggered the claim (tx.from or handleOps ops[0].sender)
 * @property {string} [poolToken] - Pool token address whose fees were claimed (from same-tx Transfer logs)
 * @property {string} [poolSymbol] - Pool token symbol (e.g. "UNC")
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
            if (value === 0n || value < MIN_WETH_CLAIM) continue;
            const txHash = log.transactionHash ?? "";
            if (!txHash) continue;
            if (recentTxHashes.has(txHash)) continue;
            recentTxHashes.add(txHash);
            if (recentTxHashes.size > RECENT_TX_MAX) {
              const first = recentTxHashes.values().next().value;
              if (first) recentTxHashes.delete(first);
            }
            const feeLockerAddr = (log.args?.from ?? locker).toLowerCase();
            const payload = {
              beneficiary: (log.args?.to ?? "").toLowerCase(),
              token: tokenAddr,
              amount: String(value),
              txHash,
              feeLocker: feeLockerAddr,
              symbol: "WETH",
              decimals: 18,
              amountFormatted: (Number(value) / 1e18).toFixed(4),
            };
            try {
              const enriched = await enrichClaim(publicClient, txHash, feeLockerAddr);
              if (enriched.claimer) payload.claimer = enriched.claimer;
              if (enriched.poolToken) payload.poolToken = enriched.poolToken;
              if (enriched.poolSymbol) payload.poolSymbol = enriched.poolSymbol;
            } catch (_) {}
            // Only alert for Bankr tokens (address ends in e.g. "ba3"); ignore other Doppler platforms
            const poolAddr = payload.poolToken?.toLowerCase() ?? "";
            if (!poolAddr || !poolAddr.endsWith(BANKR_TOKEN_SUFFIX)) continue;
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

/**
 * Historical check: which Bankr tokens has a wallet claimed? Uses RPC getLogs (no WebSocket).
 * @param {string} wallet - Address to check (0x...).
 * @param {number | bigint} [fromBlock=0] - Start block.
 * @returns {Promise<Array<{ tokenAddress: string, poolSymbol: string | null, wethAmount: string, txHash: string }>>}
 */
async function getWalletClaims(wallet, fromBlock = 0) {
  const w = (wallet ?? "").trim().toLowerCase();
  if (!w || !/^0x[a-f0-9]{40}$/.test(w)) return [];
  if (CHAIN_ID !== 8453) return [];
  const results = [];
  try {
    const [viem, chains] = await Promise.all([import("viem"), import("viem/chains")]);
    const chain = chains.base?.id === CHAIN_ID ? chains.base : { id: CHAIN_ID, name: "Base", nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" }, rpcUrls: { default: { http: [getRpcUrl()] } } };
    const client = viem.createPublicClient({
      chain,
      transport: viem.http(getRpcUrl()),
    });
    const pad = (addr) => viem.zeroPadValue(addr, 32);
    const wethLower = WETH_BASE.toLowerCase();
    for (const locker of FEE_LOCKERS) {
      const logs = await client.getLogs({
        fromBlock: BigInt(fromBlock),
        toBlock: "latest",
        topics: [TRANSFER_TOPIC, pad(locker), pad(w)],
      });
      for (const log of logs) {
        const tokenAddr = (log.address ?? "").toLowerCase();
        if (tokenAddr !== wethLower) continue;
        const value = log.data ? BigInt(log.data) : 0n;
        if (value === 0n) continue;
        const txHash = log.transactionHash ?? "";
        if (!txHash) continue;
        try {
          const receipt = await client.getTransactionReceipt({ hash: txHash });
          if (!receipt?.logs?.length) continue;
          const lockerPadded = "0x" + locker.slice(2).padStart(64, "0");
          for (const l of receipt.logs) {
            if (l.topics?.[0] !== TRANSFER_TOPIC) continue;
            if ((l.topics[1] ?? "").toLowerCase() !== lockerPadded) continue;
            const addr = (l.address ?? "").toLowerCase();
            if (addr === wethLower || !addr.endsWith(BANKR_TOKEN_SUFFIX)) continue;
            const meta = await getTokenMeta(client, addr);
            results.push({
              tokenAddress: addr,
              poolSymbol: meta?.symbol ?? null,
              wethAmount: (Number(value) / 1e18).toFixed(4),
              txHash,
            });
            break;
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
  return results;
}

/**
 * Historical: which wallets have claimed this Bankr token? Uses RPC getLogs (WETH from fee lockers, then receipt has token).
 * @param {string} tokenAddress - Bankr token (0x...ba3).
 * @param {number | bigint} [fromBlock=0] - Start block.
 * @param {number} [maxLogs=200] - Max WETH transfer logs to process (then stop to avoid rate limits).
 * @returns {Promise<Array<{ beneficiary: string, wethAmount: string, txHash: string }>>}
 */
async function getTokenClaims(tokenAddress, fromBlock = 0, maxLogs = 200) {
  const token = (tokenAddress ?? "").trim().toLowerCase();
  if (!token || !/^0x[a-f0-9]{40}$/.test(token) || !token.endsWith(BANKR_TOKEN_SUFFIX)) return [];
  if (CHAIN_ID !== 8453) return [];
  const results = [];
  try {
    const [viem, chains] = await Promise.all([import("viem"), import("viem/chains")]);
    const chain = chains.base?.id === CHAIN_ID ? chains.base : { id: CHAIN_ID, name: "Base", nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" }, rpcUrls: { default: { http: [getRpcUrl()] } } };
    const client = viem.createPublicClient({
      chain,
      transport: viem.http(getRpcUrl()),
    });
    const pad = (addr) => viem.zeroPadValue(addr, 32);
    const wethLower = WETH_BASE.toLowerCase();
    let totalProcessed = 0;
    for (const locker of FEE_LOCKERS) {
      if (totalProcessed >= maxLogs) break;
      const logs = await client.getLogs({
        address: wethLower,
        fromBlock: BigInt(fromBlock),
        toBlock: "latest",
        topics: [TRANSFER_TOPIC, pad(locker)],
      });
      for (const log of logs) {
        if (totalProcessed >= maxLogs) break;
        totalProcessed++;
        const value = log.data ? BigInt(log.data) : 0n;
        if (value === 0n) continue;
        const txHash = log.transactionHash ?? "";
        const toTopic = log.topics?.[2];
        const beneficiary = toTopic ? "0x" + String(toTopic).slice(-40).toLowerCase() : "";
        if (!txHash || !beneficiary) continue;
        try {
          const receipt = await client.getTransactionReceipt({ hash: txHash });
          if (!receipt?.logs?.length) continue;
          const hasToken = receipt.logs.some((l) => (l.address ?? "").toLowerCase() === token);
          if (!hasToken) continue;
          results.push({
            beneficiary,
            wethAmount: (Number(value) / 1e18).toFixed(4),
            txHash,
          });
        } catch (_) {}
      }
    }
  } catch (_) {}
  return results;
}

export { start, stop, onFeeClaim, getWsUrl, getWalletClaims, getTokenClaims };
