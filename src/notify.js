#!/usr/bin/env node
/**
 * Poll for new Bankr launches and send to Discord webhook + Telegram.
 * Tracks seen tokens to avoid duplicate notifications.
 *
 * Data sources (in order): Bankr API → Doppler Indexer → Chain (Airlock events)
 *
 * Env:
 *   BANKR_API_KEY        - Bankr API key (recommended: Bankr-only launches, no RPC)
 *   DISCORD_WEBHOOK_URL  - Discord webhook URL (optional)
 *   TELEGRAM_BOT_TOKEN   - Telegram bot token (optional)
 *   TELEGRAM_CHAT_ID     - Telegram chat/channel ID (optional)
 *   CHAIN_ID             - 8453 (Base) or 84532 (Base Sepolia)
 *   DOPPLER_INDEXER_URL  - Indexer URL (fallback when no Bankr API key)
 *   SEEN_FILE            - Path to store seen tokens (default: .bankr-seen.json)
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { fetchNewLaunches } from "./fetch-from-chain.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BANKR_API_KEY = process.env.BANKR_API_KEY;
const BANKR_LAUNCHES_LIMIT = parseInt(process.env.BANKR_LAUNCHES_LIMIT || "500", 10);
const FILTER_X_MATCH = process.env.FILTER_X_MATCH === "1" || process.env.FILTER_X_MATCH === "true";
const DOPPLER_INDEXER_URL =
  process.env.DOPPLER_INDEXER_URL || "https://testnet-indexer.doppler.lol";
const CHAIN_ID = parseInt(process.env.CHAIN_ID || "8453", 10);
const SEEN_FILE = process.env.SEEN_FILE || join(process.cwd(), ".bankr-seen.json");
const DEPLOY_COUNT_FILE = process.env.DEPLOY_COUNT_FILE || join(process.cwd(), ".bankr-deploy-counts.json");
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID;

const BASESCAN = CHAIN_ID === 8453 ? "https://basescan.org" : "https://sepolia.basescan.org";

function formatLaunch(t) {
  const links =
    t.tokenUriData && typeof t.tokenUriData === "object"
      ? {
          x: t.tokenUriData.x || t.tokenUriData.twitter || null,
          website:
            t.tokenUriData.websiteUrl ||
            t.tokenUriData.website ||
            t.tokenUriData.content?.uri ||
            null,
        }
      : { x: null, website: null };
  return {
    name: t.name,
    symbol: t.symbol,
    tokenAddress: t.address,
    launcher: t.creatorAddress || null,
    beneficiaries: t.pool?.beneficiaries ?? null,
    image: t.image || null,
    pool: t.pool?.address ?? t.pool ?? null,
    volumeUsd: t.volumeUsd != null ? String(t.volumeUsd) : null,
    holderCount: t.holderCount ?? null,
    ...links,
  };
}

function normX(u) {
  if (!u || typeof u !== "string") return null;
  return u.startsWith("@") ? u.slice(1).toLowerCase() : u.toLowerCase();
}

function normHandle(u) {
  if (!u || typeof u !== "string") return null;
  const s = String(u).trim().toLowerCase();
  return s || null;
}

function getFarcaster(d) {
  return d?.farcasterUsername || d?.farcaster || d?.fcUsername || null;
}

function formatBankrLaunch(l) {
  const rawDeployerX = l.deployer?.xUsername ? (l.deployer.xUsername.startsWith("@") ? l.deployer.xUsername.slice(1) : l.deployer.xUsername) : null;
  const rawFeeX = l.feeRecipient?.xUsername ? (l.feeRecipient.xUsername.startsWith("@") ? l.feeRecipient.xUsername.slice(1) : l.feeRecipient.xUsername) : null;
  const rawDeployerFc = getFarcaster(l.deployer);
  const rawFeeFc = getFarcaster(l.feeRecipient);
  const deployerX = normX(rawDeployerX);
  const feeX = normX(rawFeeX);
  const deployerFc = normHandle(rawDeployerFc);
  const feeFc = normHandle(rawFeeFc);
  const x = deployerX || feeX || null;
  return {
    name: l.tokenName,
    symbol: l.tokenSymbol,
    tokenAddress: l.tokenAddress,
    launcher: l.deployer?.walletAddress ?? null,
    launcherX: rawDeployerX,
    launcherFarcaster: rawDeployerFc,
    launcherWallet: l.deployer?.walletAddress ?? null,
    beneficiaries: l.feeRecipient?.walletAddress
      ? [{ beneficiary: l.feeRecipient.walletAddress, xUsername: rawFeeX, farcaster: rawFeeFc }]
      : null,
    image: l.imageUri || null,
    pool: l.poolId ?? null,
    volumeUsd: null,
    holderCount: null,
    x: rawDeployerX || rawFeeX || null,
    website: l.websiteUrl || null,
    tweetUrl: l.tweetUrl || null,
  };
}

async function fetchFromBankrApi() {
  if (!BANKR_API_KEY) return null;
  try {
    const seen = new Set();
    const allLaunches = [];
    const pageSize = 50;
    let offset = 0;

    while (offset < BANKR_LAUNCHES_LIMIT) {
      const url = `https://api.bankr.bot/token-launches?limit=${pageSize}&offset=${offset}`;
      const res = await fetch(url, {
        headers: {
          "X-API-Key": BANKR_API_KEY,
          Accept: "application/json",
        },
      });
      if (!res.ok) break;
      const json = await res.json();
      const batch = json.launches?.filter((l) => l.status === "deployed") ?? [];
      if (batch.length === 0) break;

      for (const l of batch) {
        const key = l.tokenAddress?.toLowerCase();
        if (key && !seen.has(key)) {
          seen.add(key);
          allLaunches.push(l);
        }
      }
      if (batch.length < pageSize) break;
      offset += batch.length;
    }

    if (allLaunches.length > 0) return allLaunches.map(formatBankrLaunch);
  } catch {
    /* non-fatal */
  }
  return null;
}

async function fetchLaunches() {
  if (BANKR_API_KEY && CHAIN_ID === 8453) {
    const bankrLaunches = await fetchFromBankrApi();
    if (bankrLaunches?.length > 0) return bankrLaunches;
  }

  const query = `
    query Tokens($chainId: Int!) {
      tokens(
        where: { chainId: $chainId }
        orderBy: "firstSeenAt"
        orderDirection: "desc"
        limit: 50
      ) {
        items {
          address
          chainId
          name
          symbol
          decimals
          image
          creatorAddress
          tokenUriData
          pool { address }
          volumeUsd
          holderCount
        }
      }
    }
  `;
  const res = await fetch(
    `${DOPPLER_INDEXER_URL.replace(/\/$/, "")}/graphql`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { chainId: CHAIN_ID } }),
    }
  );
  if (!res.ok) {
    console.error(`Indexer HTTP ${res.status} from ${DOPPLER_INDEXER_URL}`);
  } else {
    const json = await res.json();
    if (json.errors) {
      console.error("Indexer GraphQL errors:", JSON.stringify(json.errors));
    } else {
      const items = json.data?.tokens?.items ?? [];
      if (items.length > 0) return items.map(formatLaunch);
    }
  }
  console.error(`Indexer empty/failed for chainId ${CHAIN_ID}. Trying chain fallback...`);
  try {
    const chainLaunches = await fetchNewLaunches();
    return chainLaunches.map((l) => ({
      name: l.name,
      symbol: l.symbol,
      tokenAddress: l.tokenAddress,
      launcher: null,
      beneficiaries: null,
      image: l.image || null,
      pool: l.poolId,
      volumeUsd: null,
      holderCount: null,
      x: l.x || null,
      website: l.website || null,
    }));
  } catch (e) {
    console.error("Chain fallback failed (set RPC_URL_BASE):", e.message);
    return [];
  }
}

async function loadSeen() {
  try {
    const data = await readFile(SEEN_FILE, "utf-8");
    return new Set(JSON.parse(data));
  } catch {
    return new Set();
  }
}

async function saveSeen(seen) {
  await mkdir(dirname(SEEN_FILE), { recursive: true }).catch(() => {});
  await writeFile(SEEN_FILE, JSON.stringify([...seen], null, 0));
}

async function loadDeployCounts() {
  try {
    const data = await readFile(DEPLOY_COUNT_FILE, "utf-8");
    const raw = JSON.parse(data);
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (Array.isArray(v)) out[k.toLowerCase()] = new Set(v);
      else if (typeof v === "number") out[k.toLowerCase()] = new Set(Array(v).fill(null));
    }
    return out;
  } catch {
    return {};
  }
}

async function saveDeployCounts(counts) {
  try {
    await mkdir(dirname(DEPLOY_COUNT_FILE), { recursive: true }).catch(() => {});
    const out = {};
    for (const [k, v] of Object.entries(counts)) {
      out[k] = [...v];
    }
    await writeFile(DEPLOY_COUNT_FILE, JSON.stringify(out));
  } catch {
    /* non-fatal */
  }
}

function imageUrl(img) {
  if (!img) return null;
  if (img.startsWith("ipfs://"))
    return img.replace("ipfs://", "https://ipfs.io/ipfs/");
  return img;
}

function walletLink(addr) {
  if (!addr || typeof addr !== "string") return null;
  return `${BASESCAN}/address/${addr}`;
}

function xProfileUrl(handle) {
  if (!handle || typeof handle !== "string") return null;
  const u = handle.startsWith("@") ? handle.slice(1) : handle;
  return `https://x.com/${u}`;
}

function farcasterProfileUrl(handle) {
  if (!handle || typeof handle !== "string") return null;
  const u = String(handle).replace(/^@/, "").replace(/\.eth$/i, "");
  return `https://warpcast.com/${u}`;
}

function bankrLaunchUrl(tokenAddress) {
  return `https://bankr.bot/launches/${tokenAddress}`;
}

async function sendDiscord(launch) {
  if (!DISCORD_WEBHOOK) return;
  const launchUrl = bankrLaunchUrl(launch.tokenAddress);
  const basescanTokenUrl = `${BASESCAN}/token/${launch.tokenAddress}`;
  const img = imageUrl(launch.image);

  let launcherValue = "—";
  if (launch.launcher) {
    const launcherAddrUrl = walletLink(launch.launcher);
    const launcherAddrLink = launcherAddrUrl ? `[${launch.launcher}](${launcherAddrUrl})` : `\`${launch.launcher}\``;
    const parts = [];
    if (launch.launcherX) parts.push(`**X:** [@${launch.launcherX}](${xProfileUrl(launch.launcherX)})`);
    if (launch.launcherFarcaster) parts.push(`**Farcaster:** [${launch.launcherFarcaster}](${farcasterProfileUrl(launch.launcherFarcaster)})`);
    parts.push(`**Wallet:** ${launcherAddrLink}`);
    launcherValue = parts.join("\n");
  }

  const fields = [
    { name: "Token", value: `${launch.name} ($${launch.symbol})`, inline: true },
    { name: "CA", value: `[\`${launch.tokenAddress.slice(0, 10)}...\`](${basescanTokenUrl})`, inline: true },
    { name: "Launcher", value: launcherValue, inline: false },
  ];

  if (launch.beneficiaries && launch.beneficiaries.length) {
    const bens = launch.beneficiaries
      .map((b) => {
        const addr = typeof b === "object" ? b.beneficiary || b.address : b;
        const addrUrl = walletLink(addr);
        const addrLink = addrUrl ? `[${addr}](${addrUrl})` : `\`${addr}\``;
        const parts = [];
        if (b.xUsername) parts.push(`**X:** [@${b.xUsername}](${xProfileUrl(b.xUsername)})`);
        if (b.farcaster) parts.push(`**Farcaster:** [${b.farcaster}](${farcasterProfileUrl(b.farcaster)})`);
        parts.push(`**Wallet:** ${addrLink}`);
        return parts.join("\n");
      })
      .join("\n\n");
    fields.push({ name: "Fee recipient", value: bens.slice(0, 1024) || "—", inline: false });
  }

  if (launch.deployCount != null && launch.deployCount > 1) {
    fields.push({ name: "Deploys (in feed)", value: `${launch.deployCount}`, inline: true });
  }
  if (launch.tweetUrl) fields.push({ name: "Tweet", value: launch.tweetUrl, inline: false });
  if (launch.website) fields.push({ name: "Website", value: launch.website, inline: true });
  if (launch.x && !launch.launcherX && !launch.beneficiaries?.some((b) => b.xUsername === launch.x)) {
    fields.push({ name: "X", value: `[@${launch.x}](${xProfileUrl(launch.x)})`, inline: true });
  }

  const embed = {
    title: `New launch: ${launch.name} ($${launch.symbol})`,
    url: launchUrl,
    color: 0x0052ff,
    fields,
    timestamp: new Date().toISOString(),
  };
  if (img) embed.thumbnail = { url: img };

  await fetch(DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });
}

function escapeMarkdown(s) {
  if (!s || typeof s !== "string") return "";
  return s.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

async function sendTelegram(launch) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  const launchUrl = bankrLaunchUrl(launch.tokenAddress);
  const basescanTokenUrl = `${BASESCAN}/token/${launch.tokenAddress}`;
  let text = `[New launch: ${escapeMarkdown(launch.name)} ($${escapeMarkdown(launch.symbol)})](${launchUrl})\n\n`;
  text += `[View on Bankr](${launchUrl}) | [Basescan](${basescanTokenUrl})\n`;
  text += `*CA:* \`${launch.tokenAddress}\`\n`;

  if (launch.launcher) {
    text += `*Launcher:*\n`;
    if (launch.launcherX) text += `  X: [@${escapeMarkdown(launch.launcherX)}](${xProfileUrl(launch.launcherX)})\n`;
    if (launch.launcherFarcaster) text += `  Farcaster: [${escapeMarkdown(launch.launcherFarcaster)}](${farcasterProfileUrl(launch.launcherFarcaster)})\n`;
    text += `  Wallet: [${launch.launcher}](${walletLink(launch.launcher)})\n`;
  }

  if (launch.beneficiaries?.length) {
    text += `*Fee recipient:*\n`;
    for (const b of launch.beneficiaries) {
      const addr = typeof b === "object" ? b.beneficiary || b.address : b;
      if (b.xUsername) text += `  X: [@${escapeMarkdown(b.xUsername)}](${xProfileUrl(b.xUsername)})\n`;
      if (b.farcaster) text += `  Farcaster: [${escapeMarkdown(b.farcaster)}](${farcasterProfileUrl(b.farcaster)})\n`;
      text += `  Wallet: [${addr}](${walletLink(addr)})\n`;
    }
  }

  if (launch.deployCount != null && launch.deployCount > 1) {
    text += `*Deploys (in feed):* ${launch.deployCount}\n`;
  }
  if (launch.tweetUrl) text += `*Tweet:* ${launch.tweetUrl}\n`;
  if (launch.website) text += `*Website:* ${launch.website}\n`;

  const img = launch.image ? imageUrl(launch.image) : null;
  const basePayload = { chat_id: TELEGRAM_CHAT, disable_web_page_preview: true };

  try {
    if (img) {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...basePayload, photo: img, caption: text, parse_mode: "Markdown" }),
      });
    } else {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...basePayload, text, parse_mode: "Markdown" }),
      });
    }
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}

async function main() {
  if (!DISCORD_WEBHOOK && !(TELEGRAM_TOKEN && TELEGRAM_CHAT)) {
    console.error(
      "Set DISCORD_WEBHOOK_URL and/or TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID"
    );
    process.exit(1);
  }

  const seen = await loadSeen();
  const deployCounts = await loadDeployCounts();

  const source = BANKR_API_KEY && CHAIN_ID === 8453 ? "Bankr API" : `indexer=${DOPPLER_INDEXER_URL}`;
  console.log(`Fetching launches (chainId=${CHAIN_ID}, ${source})...`);
  const launches = await fetchLaunches();
  if (!launches?.length) {
    console.log("No launches found. Check: CHAIN_ID matches your indexer (84532=testnet, 8453=mainnet). For Base mainnet add RPC_URL_BASE as fallback.");
    return;
  }

  for (const l of launches) {
    const addr = l.launcher?.toLowerCase();
    if (addr && l.tokenAddress) {
      if (!deployCounts[addr]) deployCounts[addr] = new Set();
      deployCounts[addr].add(l.tokenAddress.toLowerCase());
    }
  }
  await saveDeployCounts(deployCounts);

  const newLaunches = launches.filter((l) => {
    const key = `${CHAIN_ID}:${l.tokenAddress.toLowerCase()}`;
    if (seen.has(key)) return false;

    if (FILTER_X_MATCH) {
      const deployerX = l.launcherX ? normX(String(l.launcherX)) : null;
      const feeX = l.beneficiaries?.[0]?.xUsername ? normX(String(l.beneficiaries[0].xUsername)) : null;
      const deployerFc = l.launcherFarcaster ? normHandle(String(l.launcherFarcaster)) : null;
      const feeFc = l.beneficiaries?.[0]?.farcaster ? normHandle(String(l.beneficiaries[0].farcaster)) : null;
      const xMatch = deployerX && feeX && deployerX === feeX;
      const fcMatch = deployerFc && feeFc && deployerFc === feeFc;
      if (!xMatch && !fcMatch) return false;
    }

    seen.add(key);
    return true;
  });

  for (const launch of newLaunches) {
    const count = launch.launcher ? deployCounts[launch.launcher.toLowerCase()]?.size : null;
    const enriched = { ...launch, deployCount: count ?? undefined };
    console.log(`Notifying: ${launch.name} ($${launch.symbol})`);
    await sendDiscord(enriched);
    await sendTelegram(enriched);
  }

  await saveSeen(seen);
  console.log(`Done. ${newLaunches.length} new, ${launches.length} total.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
