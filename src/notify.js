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
const DOPPLER_INDEXER_URL =
  process.env.DOPPLER_INDEXER_URL || "https://testnet-indexer.doppler.lol";
const CHAIN_ID = parseInt(process.env.CHAIN_ID || "8453", 10);
const SEEN_FILE = process.env.SEEN_FILE || join(process.cwd(), ".bankr-seen.json");
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

function formatBankrLaunch(l) {
  const x = l.deployer?.xUsername || l.feeRecipient?.xUsername || null;
  return {
    name: l.tokenName,
    symbol: l.tokenSymbol,
    tokenAddress: l.tokenAddress,
    launcher: l.deployer?.walletAddress ?? null,
    beneficiaries: l.feeRecipient?.walletAddress
      ? [{ beneficiary: l.feeRecipient.walletAddress }]
      : null,
    image: l.imageUri || null,
    pool: l.poolId ?? null,
    volumeUsd: null,
    holderCount: null,
    x: x ? (x.startsWith("@") ? x.slice(1) : x) : null,
    website: l.websiteUrl || null,
  };
}

async function fetchFromBankrApi() {
  if (!BANKR_API_KEY) return null;
  try {
    const res = await fetch("https://api.bankr.bot/token-launches", {
      headers: {
        "X-API-Key": BANKR_API_KEY,
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const launches = json.launches?.filter((l) => l.status === "deployed") ?? [];
    if (launches.length > 0) return launches.map(formatBankrLaunch);
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

function imageUrl(img) {
  if (!img) return null;
  if (img.startsWith("ipfs://"))
    return img.replace("ipfs://", "https://ipfs.io/ipfs/");
  return img;
}

async function sendDiscord(launch) {
  if (!DISCORD_WEBHOOK) return;
  const url = `${BASESCAN}/token/${launch.tokenAddress}`;
  const img = imageUrl(launch.image);
  const fields = [
    { name: "Token", value: `${launch.name} ($${launch.symbol})`, inline: true },
    { name: "CA", value: `[\`${launch.tokenAddress.slice(0, 10)}...\`](${url})`, inline: true },
    { name: "Launcher", value: launch.launcher ? `\`${launch.launcher}\`` : "—", inline: false },
  ];
  if (launch.beneficiaries && launch.beneficiaries.length) {
    const bens = launch.beneficiaries
      .map((b) => (typeof b === "object" ? b.beneficiary || b.address : b))
      .join(", ");
    fields.push({ name: "Fee recipients", value: bens.slice(0, 1024) || "—", inline: false });
  }
  if (launch.x) fields.push({ name: "X", value: launch.x, inline: true });
  if (launch.website) fields.push({ name: "Website", value: launch.website, inline: true });

  const embed = {
    title: `New launch: ${launch.name} ($${launch.symbol})`,
    url,
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
  const url = `${BASESCAN}/token/${launch.tokenAddress}`;
  let text = `*New launch: ${escapeMarkdown(launch.name)} ($${escapeMarkdown(launch.symbol)})*\n\n`;
  text += `[View on Basescan](${url})\n`;
  text += `*CA:* \`${launch.tokenAddress}\`\n`;
  if (launch.launcher) text += `*Launcher:* \`${launch.launcher}\`\n`;
  if (launch.beneficiaries?.length) {
    const bens = launch.beneficiaries
      .map((b) => (typeof b === "object" ? b.beneficiary || b.address : b))
      .join(", ");
    text += `*Fee recipients:* ${escapeMarkdown(bens)}\n`;
  }
  if (launch.x) text += `*X:* ${escapeMarkdown(launch.x)}\n`;
  if (launch.website) text += `*Website:* ${escapeMarkdown(launch.website)}\n`;

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
  const source = BANKR_API_KEY && CHAIN_ID === 8453 ? "Bankr API" : `indexer=${DOPPLER_INDEXER_URL}`;
  console.log(`Fetching launches (chainId=${CHAIN_ID}, ${source})...`);
  const launches = await fetchLaunches();
  if (!launches?.length) {
    console.log("No launches found. Check: CHAIN_ID matches your indexer (84532=testnet, 8453=mainnet). For Base mainnet add RPC_URL_BASE as fallback.");
    return;
  }

  const newLaunches = launches.filter((l) => {
    const key = `${CHAIN_ID}:${l.tokenAddress.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const launch of newLaunches) {
    console.log(`Notifying: ${launch.name} ($${launch.symbol})`);
    await sendDiscord(launch);
    await sendTelegram(launch);
  }

  await saveSeen(seen);
  console.log(`Done. ${newLaunches.length} new, ${launches.length} total.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
