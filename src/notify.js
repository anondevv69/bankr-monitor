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
import { getWatchList } from "./watch-store.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { fetchNewLaunches } from "./fetch-from-chain.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BANKR_API_KEY = process.env.BANKR_API_KEY;
// Cap pagination to avoid 429; only need recent launches for notify. Override with BANKR_LAUNCHES_LIMIT.
const BANKR_LAUNCHES_LIMIT = Math.min(
  parseInt(process.env.BANKR_LAUNCHES_LIMIT || "500", 10),
  2000
);
const FILTER_X_MATCH = process.env.FILTER_X_MATCH === "1" || process.env.FILTER_X_MATCH === "true";
const FILTER_MAX_DEPLOYS = process.env.FILTER_MAX_DEPLOYS ? parseInt(process.env.FILTER_MAX_DEPLOYS, 10) : null;
const DOPPLER_INDEXER_URL =
  process.env.DOPPLER_INDEXER_URL || "https://testnet-indexer.doppler.lol";
const CHAIN_ID = parseInt(process.env.CHAIN_ID || "8453", 10);
const SEEN_FILE = process.env.SEEN_FILE || join(process.cwd(), ".bankr-seen.json");
const SEEN_MAX_KEYS = process.env.SEEN_MAX_KEYS != null ? parseInt(process.env.SEEN_MAX_KEYS, 10) : null;
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

function walletAddr(obj) {
  if (obj == null) return null;
  if (typeof obj === "string" && /^0x[a-fA-F0-9]{40}$/.test(obj.trim())) return obj.trim().toLowerCase();
  const a = obj.walletAddress ?? obj.wallet ?? obj.address ?? obj.beneficiary;
  return a && /^0x[a-fA-F0-9]{40}$/.test(String(a).trim()) ? String(a).trim().toLowerCase() : null;
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
  const launcherWallet = walletAddr(l.deployer) ?? walletAddr(l.deployerWallet ?? l.deployerWalletAddress);
  const feeWallet = walletAddr(l.feeRecipient) ?? walletAddr(l.feeRecipientWallet ?? l.feeRecipientWalletAddress ?? l.feeRecipientAddress);
  return {
    name: l.tokenName,
    symbol: l.tokenSymbol,
    tokenAddress: l.tokenAddress,
    launcher: launcherWallet,
    launcherX: rawDeployerX,
    launcherFarcaster: rawDeployerFc,
    launcherWallet,
    beneficiaries: feeWallet
      ? [{ beneficiary: feeWallet, xUsername: rawFeeX, farcaster: rawFeeFc }]
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
      const orderParam = offset === 0 ? "&order=desc" : "";
      const url = `https://api.bankr.bot/token-launches?limit=${pageSize}&offset=${offset}${orderParam}`;
      const res = await fetch(url, {
        headers: {
          "X-API-Key": BANKR_API_KEY,
          Accept: "application/json",
        },
      });
      if (!res.ok) {
        if (res.status === 429) {
          console.warn("[Bankr API] Rate limited (429). Using results so far; next poll after interval.");
        } else {
          console.error(`[Bankr API] ${res.status} ${res.statusText}: ${url}`);
        }
        break;
      }
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
  } catch (e) {
    console.error("[Bankr API] Error:", e.message || e);
  }
  return null;
}

/** Fetch one launch by token address (Bankr GET token-launches/:address). Returns full launch with deployer/feeRecipient or null. */
async function fetchSingleBankrLaunch(tokenAddress) {
  if (!BANKR_API_KEY || !tokenAddress) return null;
  try {
    const url = `https://api.bankr.bot/token-launches/${encodeURIComponent(tokenAddress)}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "X-API-Key": BANKR_API_KEY },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const raw = json.launch ?? json;
    if (raw?.tokenAddress) return raw;
  } catch {
    /* ignore */
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
    const arr = JSON.parse(data);
    if (!Array.isArray(arr)) return [];
    if (SEEN_MAX_KEYS != null && SEEN_MAX_KEYS > 0 && arr.length > SEEN_MAX_KEYS)
      return arr.slice(-SEEN_MAX_KEYS);
    return arr;
  } catch {
    return [];
  }
}

async function saveSeen(seenArr) {
  await mkdir(dirname(SEEN_FILE), { recursive: true }).catch(() => {});
  const toSave = SEEN_MAX_KEYS != null && SEEN_MAX_KEYS > 0 && seenArr.length > SEEN_MAX_KEYS
    ? seenArr.slice(-SEEN_MAX_KEYS)
    : seenArr;
  await writeFile(SEEN_FILE, JSON.stringify(toSave, null, 0));
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

const GMGN_REFERRAL = "infobot";

/** Trade links for a Base token (GMGN Telegram, BB, FCW). Used in token detail embed. GMGN uses referral i_infobot. */
function buildTradeLinks(tokenAddress) {
  const addr = (tokenAddress || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return "—";
  const gmgnUrl = `https://t.me/GMGN_swap_bot?start=i_${GMGN_REFERRAL}_c_${addr}`;
  const bbUrl = `https://t.me/based_eth_bot?start=r_bankr_b_${addr}`;
  const fcwUrl = `https://warpcast.com/~/wallet/swap?token=${addr}&chain=base`;
  return `💱 Trade [GMGN](${gmgnUrl}) • [BB](${bbUrl}) • [FCW](${fcwUrl})`;
}

/**
 * Build rich embed for a single Bankr token (when user pastes address or uses /fees-token style reply).
 * @param {object} out - Result from getTokenFees(tokenAddress): { name, symbol, launch, volumeUsd, formatUsd }
 * @param {string} tokenAddress - Normalized token address.
 * @returns {object} Discord embed object.
 */
export function buildTokenDetailEmbed(out, tokenAddress) {
  const launchUrl = bankrLaunchUrl(tokenAddress);
  const basescanTokenUrl = `${BASESCAN}/token/${tokenAddress}`;
  const name = out.name ?? "—";
  const symbol = out.symbol ?? "—";
  const launch = out.launch ?? null;
  const img = (launch?.imageUri || launch?.image) ? imageUrl(launch.imageUri || launch.image) : null;

  const tokenLines = [
    `**Chain:** Base`,
    `**CA:** [\`${tokenAddress}\`](${basescanTokenUrl})`,
    `**Bankr:** [View Launch](${launchUrl})`,
  ];
  if (out.dexMetrics?.marketCap != null && out.formatUsd) {
    const mc = out.formatUsd(out.dexMetrics.marketCap);
    if (mc) tokenLines.push(`**Market Cap:** ${mc}`);
  }
  if (out.volumeUsd != null && out.formatUsd) {
    const vol = out.formatUsd(out.volumeUsd);
    if (vol) tokenLines.push(`**Volume:** ${vol}`);
  }
  const trades = out.dexMetrics?.trades24h;
  if (trades && (trades.buys > 0 || trades.sells > 0)) {
    tokenLines.push(`**24H:** 🟢 ${trades.buys} buys • 🔴 ${trades.sells} sells`);
  }

  const fields = [
    { name: "Token", value: tokenLines.join("\n"), inline: false },
  ];

  let deployerValue = "—";
  if (launch?.deployer) {
    const d = launch.deployer;
    const wallet = d.walletAddress ?? d.wallet ?? null;
    const parts = [];
    if (wallet) parts.push(`**Wallet:** ${walletLink(wallet) ? `[${wallet}](${walletLink(wallet)})` : `\`${wallet}\``}`);
    const xUser = d.xUsername ?? d.x ?? null;
    if (xUser) parts.push(`**X:** [@${xUser.replace(/^@/, "")}](${xProfileUrl(xUser)})`);
    const fc = d.farcasterUsername ?? d.farcaster ?? d.fcUsername ?? null;
    if (fc) parts.push(`**Farcaster:** [${fc}](${farcasterProfileUrl(fc)})`);
    if (parts.length) deployerValue = parts.join("\n");
  }
  fields.push({ name: "Deployer", value: deployerValue, inline: false });

  let feeValue = "—";
  if (launch?.feeRecipient) {
    const f = launch.feeRecipient;
    const wallet = f.walletAddress ?? f.wallet ?? null;
    const parts = [];
    if (wallet) parts.push(`**Wallet:** ${walletLink(wallet) ? `[${wallet}](${walletLink(wallet)})` : `\`${wallet}\``}`);
    const xUser = f.xUsername ?? f.x ?? null;
    if (xUser) parts.push(`**X:** [@${xUser.replace(/^@/, "")}](${xProfileUrl(xUser)})`);
    const fc = f.farcasterUsername ?? f.farcaster ?? f.fcUsername ?? null;
    if (fc) parts.push(`**Farcaster:** [${fc}](${farcasterProfileUrl(fc)})`);
    if (parts.length) feeValue = parts.join("\n");
  }
  fields.push({ name: "Fee Recipient", value: feeValue, inline: false });

  if (launch?.tweetUrl) fields.push({ name: "Tweet", value: launch.tweetUrl, inline: false });
  if (launch?.websiteUrl || launch?.website) fields.push({ name: "Website", value: launch.websiteUrl || launch.website || "—", inline: true });
  fields.push({ name: "\u200b", value: buildTradeLinks(tokenAddress), inline: false });

  const embed = {
    color: 0x0052ff,
    title: `Bankr • ${name} ($${symbol})`,
    url: launchUrl,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: "BankrMonitor • bankr.bot" },
  };
  if (img) embed.thumbnail = { url: img };
  return embed;
}

/** Build launch embed (for webhook or bot). Exported for discord-bot. */
export function buildLaunchEmbed(launch) {
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
  fields.push({ name: "\u200b", value: buildTradeLinks(launch.tokenAddress), inline: false });

  const embed = {
    title: `New launch: ${launch.name} ($${launch.symbol})`,
    url: launchUrl,
    color: 0x0052ff,
    fields,
    timestamp: new Date().toISOString(),
  };
  if (img) embed.thumbnail = { url: img };
  return embed;
}

async function sendDiscordWebhook(launch) {
  if (!DISCORD_WEBHOOK) return;
  const embed = buildLaunchEmbed(launch);
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

export async function sendTelegram(launch) {
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

/** Run one notify cycle: fetch, filter, update seen. Returns new launches (enriched) and whether they are watch-list matches. */
export async function runNotifyCycle() {
  const seenArr = await loadSeen();
  const deployCounts = await loadDeployCounts();

  const source = BANKR_API_KEY && CHAIN_ID === 8453 ? "Bankr API" : `indexer=${DOPPLER_INDEXER_URL}`;
  console.log(`Fetching launches (chainId=${CHAIN_ID}, ${source})...`);
  const launches = await fetchLaunches();
  if (!launches?.length) {
    console.log("No launches found. Check: CHAIN_ID matches your indexer (84532=testnet, 8453=mainnet). For Base mainnet add RPC_URL_BASE as fallback.");
    return { newLaunches: [], totalCount: 0 };
  }
  console.log(`Fetched ${launches.length} launches (seen: ${seenArr.length}${SEEN_MAX_KEYS != null ? `, max ${SEEN_MAX_KEYS}` : ""})`);

  for (const l of launches) {
    const addr = l.launcher?.toLowerCase();
    if (addr && l.tokenAddress) {
      if (!deployCounts[addr]) deployCounts[addr] = new Set();
      deployCounts[addr].add(l.tokenAddress.toLowerCase());
    }
  }
  await saveDeployCounts(deployCounts);

  const { x: watchX, fc: watchFc, wallet: watchWallet, keywords: watchKeywords } = await getWatchList();

  const hasWatchList = watchX.size > 0 || watchFc.size > 0 || watchWallet.size > 0 || watchKeywords.size > 0;
  if (hasWatchList) console.log(`[watch] Loaded: ${watchWallet.size} wallet(s), ${watchKeywords.size} keyword(s)`);

  function passesFilters(l) {
    if (FILTER_X_MATCH) {
      const deployerX = l.launcherX ? normX(String(l.launcherX)) : null;
      const feeX = l.beneficiaries?.[0]?.xUsername ? normX(String(l.beneficiaries[0].xUsername)) : null;
      const deployerFc = l.launcherFarcaster ? normHandle(String(l.launcherFarcaster)) : null;
      const feeFc = l.beneficiaries?.[0]?.farcaster ? normHandle(String(l.beneficiaries[0].farcaster)) : null;
      const xMatch = deployerX && feeX && deployerX === feeX;
      const fcMatch = deployerFc && feeFc && deployerFc === feeFc;
      if (!xMatch && !fcMatch) return false;
    }
    if (FILTER_MAX_DEPLOYS != null && FILTER_MAX_DEPLOYS > 0) {
      const count = l.launcher ? deployCounts[l.launcher.toLowerCase()]?.size : 0;
      if (count > FILTER_MAX_DEPLOYS) return false;
    }
    return true;
  }

  // Include launch if new and (passes filters OR we have a watch list). Watch list is independent of FILTER_X_MATCH / FILTER_MAX_DEPLOYS.
  const newLaunches = launches.filter((l) => {
    const key = `${CHAIN_ID}:${l.tokenAddress.toLowerCase()}`;
    if (seenArr.includes(key)) return false;
    const passes = passesFilters(l);
    if (!passes && !hasWatchList) return false;
    seenArr.push(key);
    if (SEEN_MAX_KEYS != null && SEEN_MAX_KEYS > 0 && seenArr.length > SEEN_MAX_KEYS) seenArr.shift();
    return true;
  });

  // When list API omits deployer/feeRecipient, fetch single-launch for watch matching (Bankr GET token-launches/:address)
  const SINGLE_LAUNCH_FETCH_LIMIT = Math.min(parseInt(process.env.BANKR_SINGLE_LAUNCH_FETCH_LIMIT || "15", 10), 25);
  if (hasWatchList && watchWallet.size > 0 && newLaunches.length > 0 && BANKR_API_KEY && CHAIN_ID === 8453) {
    let fetched = 0;
    for (const launch of newLaunches) {
      if (fetched >= SINGLE_LAUNCH_FETCH_LIMIT) break;
      const hasWallet = launch.launcher || (launch.beneficiaries?.length > 0);
      if (hasWallet) continue;
      const raw = await fetchSingleBankrLaunch(launch.tokenAddress);
      if (!raw) continue;
      fetched++;
      const filled = formatBankrLaunch(raw);
      if (filled.launcher) launch.launcher = filled.launcher;
      if (filled.launcherX) launch.launcherX = filled.launcherX;
      if (filled.launcherFarcaster) launch.launcherFarcaster = filled.launcherFarcaster;
      if (filled.beneficiaries?.length) launch.beneficiaries = filled.beneficiaries;
      if (fetched < newLaunches.length) await new Promise((r) => setTimeout(r, 120));
    }
    if (fetched > 0) console.log(`[watch] Fetched ${fetched} single-launch detail(s) for deployer/fee matching`);
  }

  // Watch list: ping when this wallet is deployer OR fee recipient (or keyword in name/symbol). Ignores FILTER_X_MATCH, FILTER_MAX_DEPLOYS.
  function isWatchMatch(launch) {
    const deployerX = launch.launcherX ? normX(String(launch.launcherX)) : null;
    const deployerFc = launch.launcherFarcaster ? normHandle(String(launch.launcherFarcaster)) : null;
    const normAddr = (a) => (a && /^0x[a-fA-F0-9]{40}$/.test(String(a).trim()) ? String(a).trim().toLowerCase() : null);
    const launcherAddr = normAddr(launch.launcher);
    const feeAddrs = (launch.beneficiaries || [])
      .map((b) => {
        const v = typeof b === "object" ? (b.beneficiary ?? b.address ?? b.wallet) : b;
        return normAddr(v);
      })
      .filter(Boolean);
    const allWalletAddrs = [launcherAddr, ...feeAddrs].filter(Boolean);
    const searchText = `${launch.name || ""} ${launch.symbol || ""}`.toLowerCase();
    const inWatchX = deployerX && watchX.has(deployerX);
    const inWatchFc = deployerFc && watchFc.has(deployerFc);
    const inWatchWallet = watchWallet.size > 0 && allWalletAddrs.some((a) => watchWallet.has(a));
    const inWatchKeyword = watchKeywords.size > 0 && [...watchKeywords].some(
      (kw) => searchText.includes(String(kw).toLowerCase().trim())
    );
    return !!(inWatchX || inWatchFc || inWatchWallet || inWatchKeyword);
  }

  const enriched = newLaunches.map((launch) => {
    const count = launch.launcher ? deployCounts[launch.launcher.toLowerCase()]?.size : null;
    return {
      ...launch,
      deployCount: count ?? undefined,
      isWatchMatch: isWatchMatch(launch),
      passedFilters: passesFilters(launch),
    };
  });

  await saveSeen(seenArr);
  for (const l of enriched) {
    const fee0 = l.beneficiaries?.[0] && (typeof l.beneficiaries[0] === "object" ? (l.beneficiaries[0].beneficiary ?? l.beneficiaries[0].address) : l.beneficiaries[0]);
    const launcherShort = l.launcher ? `${l.launcher.slice(0, 6)}..${l.launcher.slice(-4)}` : "—";
    const feeShort = fee0 ? `${String(fee0).slice(0, 6)}..${String(fee0).slice(-4)}` : "—";
    if (hasWatchList) console.log(`Notifying: ${l.name} ($${l.symbol}) launcher=${launcherShort} fee=${feeShort}${l.isWatchMatch ? " [WATCH MATCH]" : ""}`);
    else console.log(`Notifying: ${l.name} ($${l.symbol})${l.isWatchMatch ? " [watch]" : ""}`);
  }
  console.log(`Done. ${enriched.length} new, ${launches.length} total (seen: ${seenArr.length}). Set SEEN_FILE=/data/bankr-seen.json on a volume so seen list persists across deploys.`);
  return { newLaunches: enriched, totalCount: launches.length };
}

async function main() {
  if (!DISCORD_WEBHOOK && !(TELEGRAM_TOKEN && TELEGRAM_CHAT)) {
    console.error(
      "Set DISCORD_WEBHOOK_URL and/or TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID"
    );
    process.exit(1);
  }

  const { newLaunches } = await runNotifyCycle();
  for (const launch of newLaunches) {
    await sendDiscordWebhook(launch);
    await sendTelegram(launch);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
