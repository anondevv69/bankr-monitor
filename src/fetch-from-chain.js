#!/usr/bin/env node
/**
 * Fetch token launches by indexing Doppler/Uniswap V4 events on Base.
 * Listens for Pool Initialize events where hooks = Doppler hook (Bankr uses Doppler).
 */

import { createPublicClient, http, parseAbiItem } from "viem";
import { base } from "viem/chains";
import { DOPPLER_CONTRACTS_BASE } from "./config.js";

function getRpcUrl() {
  const url = process.env.RPC_URL_BASE || process.env.RPC_URL;
  if (!url) throw new Error("Set RPC_URL_BASE or RPC_URL in .env");
  return url;
}

const POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
const DOPPLER_HOOKS = [
  DOPPLER_CONTRACTS_BASE.RehypeDopplerHook,
  DOPPLER_CONTRACTS_BASE.DecayMulticurveInitializerHook,
  DOPPLER_CONTRACTS_BASE.UniswapV4MulticurveInitializerHook,
  DOPPLER_CONTRACTS_BASE.UniswapV4ScheduledMulticurveInitializerHook,
].map((a) => a.toLowerCase());

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

export async function fetchRecentLaunches(blocksBack = 10000) {
  const client = getClient();
  const block = await client.getBlockNumber();
  const fromBlock = block - BigInt(blocksBack);

  const logs = await client.getLogs({
    address: POOL_MANAGER,
    event: parseAbiItem(
      "event Initialize(bytes32 id, address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)"
    ),
    fromBlock,
    toBlock: block,
  });

  const launches = [];
  const WETH_BASE = "0x4200000000000000000000000000000000000006";

  for (const log of logs) {
    const { id, currency0, currency1, hooks } = log.args;
    if (!DOPPLER_HOOKS.includes(hooks?.toLowerCase())) continue;

    // One of currency0/currency1 is the token, the other is WETH
    const tokenAddress =
      currency0.toLowerCase() === WETH_BASE.toLowerCase()
        ? currency1
        : currency0;

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
      poolId: id,
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
