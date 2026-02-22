#!/usr/bin/env node
/**
 * Fetch token launches by indexing Doppler Airlock Create events on Base.
 * Bankr deploys via Doppler; Airlock.create() emits Create(asset, ...) per token.
 */

import { createPublicClient, http, parseAbiItem } from "viem";
import { base } from "viem/chains";
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { DOPPLER_CONTRACTS_BASE } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PUBLIC_BASE_RPC = "https://mainnet.base.org";

function getRpcUrl() {
  return process.env.RPC_URL_BASE || process.env.RPC_URL || PUBLIC_BASE_RPC;
}

const AIRLOCK = DOPPLER_CONTRACTS_BASE.Airlock;

const ERC20_ABI = [
  parseAbiItem("function name() view returns (string)"),
  parseAbiItem("function symbol() view returns (string)"),
  parseAbiItem("function decimals() view returns (uint8)"),
  parseAbiItem("function tokenURI(uint256) view returns (string)"),
];

let publicClient;
function getClient() {
  if (!publicClient) {
    publicClient = createPublicClient({
      chain: base,
      transport: http(getRpcUrl()),
    });
  }
  return publicClient;
}

async function getTokenMetadata(address) {
  try {
    const client = getClient();
    const [name, symbol, decimals, tokenURI] = await Promise.all([
      client.readContract({
        address,
        abi: ERC20_ABI,
        functionName: "name",
      }),
      client.readContract({
        address,
        abi: ERC20_ABI,
        functionName: "symbol",
      }),
      client.readContract({
        address,
        abi: ERC20_ABI,
        functionName: "decimals",
      }),
      client.readContract({
        address,
        abi: ERC20_ABI,
        functionName: "tokenURI",
        args: [1n],
      }).catch(() => null),
    ]);
    return { name, symbol, decimals, tokenURI };
  } catch {
    return null;
  }
}

async function fetchTokenUriData(uri) {
  if (!uri) return null;
  try {
    const url = uri.startsWith("ipfs://")
      ? uri.replace("ipfs://", "https://ipfs.io/ipfs/")
      : uri;
    const res = await fetch(url);
    return res.json();
  } catch {
    return null;
  }
}

const CHUNK_SIZE = parseInt(process.env.RPC_GETLOGS_CHUNK_SIZE || "10", 10);
const LAST_BLOCK_FILE =
  process.env.LAST_BLOCK_FILE || join(process.cwd(), ".bankr-last-block.json");

async function getLogsChunked(client, fromBlock, toBlock) {
  const chunks = [];
  let lo = fromBlock;
  while (lo <= toBlock) {
    const hi = lo + BigInt(CHUNK_SIZE - 1);
    chunks.push({
      fromBlock: lo,
      toBlock: hi > toBlock ? toBlock : hi,
    });
    lo = hi + 1n;
  }
  const allLogs = [];
  for (const { fromBlock: from, toBlock: to } of chunks) {
    const logs = await client.getLogs({
      address: AIRLOCK,
      event: parseAbiItem(
        "event Create(address asset, address indexed numeraire, address initializer, address poolOrHook)"
      ),
      fromBlock: from,
      toBlock: to,
    });
    allLogs.push(...logs);
  }
  return allLogs;
}

export async function fetchRecentLaunches(blocksBack = 10000) {
  const client = getClient();
  const block = await client.getBlockNumber();
  const fromBlock = block - BigInt(blocksBack);

  const logs = await getLogsChunked(client, fromBlock, block);
  return await processCreateLogs(logs);
}

/**
 * Incremental fetch for notify loop: only scans blocks since last poll.
 * Saves ~90% RPC calls (e.g. ~20 instead of ~500 per poll).
 */
export async function fetchNewLaunches() {
  const client = getClient();
  const block = await client.getBlockNumber();
  const chainId = parseInt(process.env.CHAIN_ID || "8453", 10);
  const blocksBack = parseInt(process.env.BLOCKS_BACK || "5000", 10);

  let fromBlock = block - BigInt(blocksBack);
  try {
    const data = await readFile(LAST_BLOCK_FILE, "utf-8");
    const { block: lastBlock, chainId: storedChain } = JSON.parse(data);
    if (storedChain === chainId && lastBlock < block) {
      fromBlock = BigInt(lastBlock) + 1n;
    }
  } catch {
    /* first run: scan full range */
  }

  const logs = await getLogsChunked(client, fromBlock, block);

  try {
    await mkdir(dirname(LAST_BLOCK_FILE), { recursive: true });
    await writeFile(
      LAST_BLOCK_FILE,
      JSON.stringify({ block: Number(block), chainId })
    );
  } catch {
    /* non-fatal */
  }

  return await processCreateLogs(logs);
}

async function processCreateLogs(logs) {
  const launches = [];
  for (const log of logs) {
    const { asset: tokenAddress, poolOrHook } = log.args;

    const meta = await getTokenMetadata(tokenAddress);
    if (!meta) continue;

    const uriData = await fetchTokenUriData(meta.tokenURI);
    const links = uriData
      ? {
          x: uriData.x || uriData.twitter || null,
          website: uriData.websiteUrl || uriData.website || uriData.content?.uri || null,
        }
      : {};

    launches.push({
      poolId: poolOrHook,
      tokenAddress,
      name: meta.name,
      symbol: meta.symbol,
      blockNumber: Number(log.blockNumber),
      txHash: log.transactionHash,
      ...links,
    });
  }

  return launches.sort((a, b) => b.blockNumber - a.blockNumber);
}

async function main() {
  const blocksBack = parseInt(process.env.BLOCKS_BACK || "50000", 10);
  console.log(`Fetching Doppler pool creations on Base (last ~${blocksBack} blocks)\n`);

  const launches = await fetchRecentLaunches(blocksBack);
  console.log(`Found ${launches.length} launches\n`);

  for (const l of launches) {
    console.log("---");
    console.log(`Token: ${l.name} ($${l.symbol})`);
    console.log(`  CA: ${l.tokenAddress}`);
    if (l.x) console.log(`  X: ${l.x}`);
    if (l.website) console.log(`  Website: ${l.website}`);
    console.log(`  Pool ID: ${l.poolId}`);
    console.log(`  Tx: ${l.txHash}`);
  }
}

// Run main only when executed directly
const isMain = process.argv[1]?.endsWith("fetch-from-chain.js");
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
