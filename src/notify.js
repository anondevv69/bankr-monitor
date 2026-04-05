#!/usr/bin/env node
/**
 * Poll for new Bankr launches and send to Discord webhook + Telegram.
 * Tracks seen tokens to avoid duplicate notifications.
 *
 * Data sources (in order): Bankr API → Doppler Indexer → Chain (Airlock events)
 *
 * Env:
 *   BANKR_API_KEY - Bankr API key (Telegram-only multi-key: TELEGRAM_BANKR_API_KEYS)
 *   DISCORD_WEBHOOK_URL  - Discord webhook URL (optional)
 *   TELEGRAM_BOT_TOKEN   - Telegram bot token (optional)
 *   TELEGRAM_CHAT_ID     - Telegram group chat ID (optional)
 *   TELEGRAM_TOPIC_FIREHOSE - Topic/thread ID for firehose (group with topics)
 *   TELEGRAM_TOPIC_CURATED  - Topic ID for curated (X / fee recipient only)
 *   TELEGRAM_TOPIC_HOT      - Topic ID for hot launches (env; per-tenant in bot)
 *   TELEGRAM_TOPIC_TRENDING - Topic ID for trending (env; per-tenant in bot)
 *   TELEGRAM_HOT_PING_DELAY_MS / TELEGRAM_OUTBOUND_DELAY_MS - Delay (ms) Telegram after Discord (default 30000; bot + notify CLI)
 *   TELEGRAM_ALLOWED_CHAT_IDS   - Comma-separated chat IDs; only these receive **outbound** notify posts from this process. Does not affect Discord bot group commands. Unset = allow all.
 *   CHAIN_ID             - 8453 (Base) or 84532 (Base Sepolia)
 *   DOPPLER_INDEXER_URL  - Indexer URL (default: https://bankr.indexer.doppler.lol; set to your endpoint if different)
 *   BANKR_INTEGRATION_ADDRESS - Filter tokens by this fee beneficiary (default: Bankr integration 0xF60633D02690e2A15A54AB919925F3d038Df163e)
 *   BANKR_TOKEN_SUFFIX       - Only treat 0x…40 addresses ending with this as Bankr (default ba3). Applies to indexer + chain fallback + hot pings.
 *   SEEN_FILE            - Path to store seen tokens (default: .bankr-seen.json)
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { getWatchList } from "./watch-store.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { fetchNewLaunches } from "./fetch-from-chain.js";
import { formatUsd, getHotTokenStats } from "./token-stats.js";
import { enrichLaunchWithBankrRoleCounts } from "./lookup-deployer.js";
import { isBankrTokenAddress } from "./bankr-token.js";
import { defaultBankrApiKey } from "./bankr-env-key.js";
import { getAddress } from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Cap pagination to avoid 429; only need recent launches for notify. Override with BANKR_LAUNCHES_LIMIT.
const BANKR_LAUNCHES_LIMIT = Math.min(
  parseInt(process.env.BANKR_LAUNCHES_LIMIT || "500", 10),
  2000
);
const FILTER_X_MATCH = process.env.FILTER_X_MATCH === "1" || process.env.FILTER_X_MATCH === "true";
const FILTER_FEE_RECIPIENT_HAS_X = process.env.FILTER_FEE_RECIPIENT_HAS_X === "1" || process.env.FILTER_FEE_RECIPIENT_HAS_X === "true";
const FILTER_MAX_DEPLOYS = process.env.FILTER_MAX_DEPLOYS ? parseInt(process.env.FILTER_MAX_DEPLOYS, 10) : null;
const DOPPLER_INDEXER_URL =
  process.env.DOPPLER_INDEXER_URL || "https://bankr.indexer.doppler.lol";
const BANKR_INTEGRATION_ADDRESS = (
  process.env.BANKR_INTEGRATION_ADDRESS || "0xF60633D02690e2A15A54AB919925F3d038Df163e"
).trim().toLowerCase();
const CHAIN_ID = parseInt(process.env.CHAIN_ID || "8453", 10);
const SEEN_FILE = process.env.SEEN_FILE || join(process.cwd(), ".bankr-seen.json");
const SEEN_MAX_KEYS = process.env.SEEN_MAX_KEYS != null ? parseInt(process.env.SEEN_MAX_KEYS, 10) : null;
const DEPLOY_COUNT_FILE = process.env.DEPLOY_COUNT_FILE || join(process.cwd(), ".bankr-deploy-counts.json");
const FEE_RECIPIENT_COUNT_FILE =
  process.env.FEE_RECIPIENT_COUNT_FILE || join(process.cwd(), ".bankr-fee-recipient-counts.json");
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID;
/** If set, only these chat IDs receive outbound Telegram posts from notify (comma-separated). Interactive bot use in other groups is unaffected. Leave unset to allow all. */
const TELEGRAM_ALLOWED_CHAT_IDS =
  process.env.TELEGRAM_ALLOWED_CHAT_IDS !== undefined
    ? String(process.env.TELEGRAM_ALLOWED_CHAT_IDS)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

function allowedTelegramChat(chatId) {
  if (!chatId) return false;
  if (TELEGRAM_ALLOWED_CHAT_IDS === null) return true;
  const id = String(chatId).trim();
  return TELEGRAM_ALLOWED_CHAT_IDS.includes(id);
}

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

/** Pick the token contract address (0x + 40 hex). Never use pool ID (0x + 64 hex). Prefer tokenAddress then asset/token. */
function pickTokenAddress(l) {
  const s = (v) => (typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v.trim()) ? v.trim().toLowerCase() : null);
  const isPoolId = (v) => typeof v === "string" && /^0x[a-fA-F0-9]{64}$/.test(v.trim());
  const tok = l.tokenAddress;
  if (s(tok)) return s(tok);
  if (isPoolId(tok)) {
    const asset = s(l.asset) ?? s(l.token) ?? s(l.address);
    if (asset) return asset;
  }
  return s(l.asset) ?? s(l.token) ?? s(l.address) ?? (tok ? tok.trim().toLowerCase() : null);
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
  const launcherWallet =
    walletAddr(l.deployerWallet ?? l.deployerWalletAddress) ?? walletAddr(l.deployer);
  const feeWallet = walletAddr(l.feeRecipient) ?? walletAddr(l.feeRecipientWallet ?? l.feeRecipientWalletAddress ?? l.feeRecipientAddress);
  const tokenAddress = pickTokenAddress(l) ?? (l.tokenAddress ? String(l.tokenAddress).trim().toLowerCase() : null);
  const deployRaw =
    l.deployedAt ??
    l.createdAt ??
    l.completedAt ??
    l.deployed_at ??
    l.created_at ??
    l.completed_at ??
    l.timestamp ??
    l.blockTimestamp;
  let deployedAtMsFromBankr = null;
  if (deployRaw != null) {
    const ms = new Date(deployRaw).getTime();
    if (Number.isFinite(ms)) deployedAtMsFromBankr = ms;
  }
  return {
    name: l.tokenName,
    symbol: l.tokenSymbol,
    tokenAddress,
    deployedAtMsFromBankr,
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

async function fetchFromBankrApi(apiKey) {
  const key = defaultBankrApiKey(apiKey);
  if (!key) return null;
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
          "X-API-Key": key,
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

    if (allLaunches.length > 0) {
      return allLaunches.map(formatBankrLaunch).filter((l) => isBankrTokenAddress(l.tokenAddress));
    }
  } catch (e) {
    console.error("[Bankr API] Error:", e.message || e);
  }
  return null;
}

/** Fetch one launch by token address (Bankr GET token-launches/:address). Returns full launch with deployer/feeRecipient or null. */
async function fetchSingleBankrLaunch(tokenAddress, apiKey) {
  const key = defaultBankrApiKey(apiKey);
  if (!key || !tokenAddress) return null;
  try {
    const url = `https://api.bankr.bot/token-launches/${encodeURIComponent(tokenAddress)}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "X-API-Key": key },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const raw = json.launch ?? json;
    if (raw && (raw.tokenAddress || raw.asset || raw.token)) return raw;
  } catch {
    /* ignore */
  }
  return null;
}

/** Fetch launch by token address and return same shape as formatBankrLaunch (for hot ping so CA/name/symbol are canonical). */
export async function fetchLaunchByTokenAddress(tokenAddress, apiKey) {
  const raw = await fetchSingleBankrLaunch(tokenAddress, apiKey);
  if (!raw || !pickTokenAddress(raw)) return null;
  return formatBankrLaunch(raw);
}

async function fetchLaunches(apiKey) {
  const key = defaultBankrApiKey(apiKey);
  if (key && CHAIN_ID === 8453) {
    const bankrLaunches = await fetchFromBankrApi(key);
    if (bankrLaunches?.length > 0) return bankrLaunches;
  }

  // Production indexer: prefer Bankr integration filter. Unscoped `tokens(where: { chainId })` also exists as last resort;
  // every path is filtered to addresses ending in BANKR_TOKEN_SUFFIX (default ba3) so non-Bankr Doppler tokens never notify.
  const queryWithBeneficiary = `
    query TokensByBeneficiary($chainId: Int!, $beneficiary: String!) {
      tokens(
        where: { chainId: $chainId, beneficiary: $beneficiary }
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
  const queryWithIntegration = `
    query TokensByIntegration($chainId: Int!, $integrationAddress: String!) {
      tokens(
        where: { chainId: $chainId, integrationAddress: $integrationAddress }
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
  const queryLegacy = `
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

  const baseUrl = `${DOPPLER_INDEXER_URL.replace(/\/$/, "")}/graphql`;
  let items = [];

  for (const { query, variables } of [
    { query: queryWithBeneficiary, variables: { chainId: CHAIN_ID, beneficiary: BANKR_INTEGRATION_ADDRESS } },
    { query: queryWithIntegration, variables: { chainId: CHAIN_ID, integrationAddress: BANKR_INTEGRATION_ADDRESS } },
    { query: queryLegacy, variables: { chainId: CHAIN_ID } },
  ]) {
    try {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      if (!res.ok) continue;
      const json = await res.json();
      if (json.errors?.length) continue;
      const next = json.data?.tokens?.items ?? [];
      const bankrOnly = next.filter((t) => isBankrTokenAddress(t.address));
      if (bankrOnly.length > 0) {
        items = bankrOnly;
        break;
      }
    } catch {
      /* try next query shape */
    }
  }

  if (items.length > 0) return items.map(formatLaunch);

  console.error(`Indexer HTTP/GraphQL failed or returned no tokens for chainId ${CHAIN_ID}. Trying chain fallback...`);
  try {
    const chainLaunches = await fetchNewLaunches();
    return chainLaunches
      .filter((l) => isBankrTokenAddress(String(l.tokenAddress)))
      .map((l) => ({
        name: l.name,
        symbol: l.symbol,
        tokenAddress: typeof l.tokenAddress === "string" ? l.tokenAddress.toLowerCase() : l.tokenAddress,
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

async function loadFeeRecipientCounts() {
  try {
    const data = await readFile(FEE_RECIPIENT_COUNT_FILE, "utf-8");
    const raw = JSON.parse(data);
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (Array.isArray(v)) out[k.toLowerCase()] = new Set(v);
    }
    return out;
  } catch {
    return {};
  }
}

async function saveFeeRecipientCounts(counts) {
  try {
    await mkdir(dirname(FEE_RECIPIENT_COUNT_FILE), { recursive: true }).catch(() => {});
    const out = {};
    for (const [k, v] of Object.entries(counts)) {
      out[k] = [...v];
    }
    await writeFile(FEE_RECIPIENT_COUNT_FILE, JSON.stringify(out));
  } catch {
    /* non-fatal */
  }
}

/** Unique Bankr tokens seen in the feed where this wallet is a fee recipient (from persisted counts). */
export async function getFeeRecipientFeedCount(walletAddress) {
  const a = walletAddress && String(walletAddress).trim().toLowerCase();
  if (!a || !/^0x[a-f0-9]{40}$/.test(a)) return null;
  const counts = await loadFeeRecipientCounts();
  const n = counts[a]?.size;
  return n != null && n > 0 ? n : null;
}

/** Unique Bankr tokens seen in the feed where this wallet is the launcher/deployer (from .bankr-deploy-counts.json). */
export async function getDeployerFeedCount(walletAddress) {
  const a = walletAddress && String(walletAddress).trim().toLowerCase();
  if (!a || !/^0x[a-f0-9]{40}$/.test(a)) return null;
  const counts = await loadDeployCounts();
  const n = counts[a]?.size;
  return n != null && n > 0 ? n : null;
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
/** @see https://t.me/Sigma_buyBot — token deep link uses ?start=xinfo-0x… (Sigma expects EIP-55 checksum in the path). */
const SIGMA_BOT_RAW = String(process.env.TELEGRAM_SIGMA_BOT_USERNAME || "Sigma_buyBot")
  .replace(/^@/, "")
  .trim();
/** Telegram’s @info is a generic contact; mis-set env often yields t.me/info — force Sigma bot. */
const SIGMA_BOT_USERNAME =
  !SIGMA_BOT_RAW || SIGMA_BOT_RAW.toLowerCase() === "info" ? "Sigma_buyBot" : SIGMA_BOT_RAW;

function sigmaTelegramTradeUrl(addr) {
  const raw = String(addr || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    return `https://t.me/${SIGMA_BOT_USERNAME}?start=xinfo-${raw}`;
  }
  let tokenPart = raw.toLowerCase();
  try {
    tokenPart = getAddress(raw);
  } catch {
    /* keep lowercase */
  }
  return `https://t.me/${SIGMA_BOT_USERNAME}?start=xinfo-${tokenPart}`;
}

/** GMGN + BB + Sigma (Markdown), for claim alerts. */
export function buildGmgnBbTradeMarkdown(tokenAddress) {
  const addr = (tokenAddress || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return "—";
  const gmgnUrl = `https://t.me/GMGN_swap_bot?start=i_${GMGN_REFERRAL}_c_${addr}`;
  const bbUrl = `https://t.me/based_eth_bot?start=r_${GMGN_REFERRAL}_b_${addr}`;
  const sigmaUrl = sigmaTelegramTradeUrl(addr);
  return `[GMGN](${gmgnUrl}) • [BB](${bbUrl}) • [Sigma](${sigmaUrl})`;
}

/** Trade links for a Base token (GMGN, BB, Sigma, FCW). Used in token detail + Discord claim embeds. */
export function buildTradeLinks(tokenAddress) {
  const addr = (tokenAddress || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return "—";
  const gmgnUrl = `https://t.me/GMGN_swap_bot?start=i_${GMGN_REFERRAL}_c_${addr}`;
  const bbUrl = `https://t.me/based_eth_bot?start=r_${GMGN_REFERRAL}_b_${addr}`;
  const sigmaUrl = sigmaTelegramTradeUrl(addr);
  const fcwUrl = `https://warpcast.com/~/wallet/swap?token=${addr}&chain=base`;
  return `💱 Trade [GMGN](${gmgnUrl}) • [BB](${bbUrl}) • [Sigma](${sigmaUrl}) • [FCW](${fcwUrl})`;
}

/** Inline keyboard: GMGN + BB + Sigma (no FCW/Warpcast — poor UX inside Telegram). */
export function buildTelegramTradeKeyboardMarkup(tokenAddress) {
  const addr = (tokenAddress || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return null;
  const gmgnUrl = `https://t.me/GMGN_swap_bot?start=i_${GMGN_REFERRAL}_c_${addr}`;
  const bbUrl = `https://t.me/based_eth_bot?start=r_${GMGN_REFERRAL}_b_${addr}`;
  const sigmaUrl = sigmaTelegramTradeUrl(addr);
  return {
    inline_keyboard: [
      [
        { text: "🔵 GMGN", url: gmgnUrl },
        { text: "🔥 BB", url: bbUrl },
        { text: "Σ Sigma", url: sigmaUrl },
      ],
    ],
  };
}

function telegramTradeKeyboard(tokenAddress) {
  return buildTelegramTradeKeyboardMarkup(tokenAddress);
}

/** Show exact count up to this value; above it show "5+" (wallet / X / Farcaster launch counts). */
export const BANKR_ROLE_COUNT_DISPLAY_CAP = 5;

/** @param {number|null|undefined} count */
export function formatBankrRoleCountDisplay(count) {
  if (count == null) return null;
  const n = Math.trunc(Number(count));
  if (!Number.isFinite(n) || n < 1) return null;
  return n > BANKR_ROLE_COUNT_DISPLAY_CAP ? `${BANKR_ROLE_COUNT_DISPLAY_CAP}+` : String(n);
}

/** Format deployer or feeRecipient object for Discord embed value (wallet + X + Farcaster links). */
function formatDeployerOrFeeForEmbed(obj) {
  if (!obj) return "—";
  const wallet = obj.walletAddress ?? obj.wallet ?? null;
  const parts = [];
  if (wallet) parts.push(`**Wallet:** ${walletLink(wallet) ? `[${wallet}](${walletLink(wallet)})` : `\`${wallet}\``}`);
  const xUser = obj.xUsername ?? obj.x ?? null;
  if (xUser) parts.push(`**X:** [@${String(xUser).replace(/^@/, "")}](${xProfileUrl(xUser)})`);
  const fc = obj.farcasterUsername ?? obj.farcaster ?? obj.fcUsername ?? null;
  if (fc) parts.push(`**Farcaster:** [${fc}](${farcasterProfileUrl(fc)})`);
  return parts.length ? parts.join("\n") : "—";
}

/**
 * @typedef {{
 *   vol24h: number, vol1h: number, buyTx24h: number, sellTx24h: number,
 *   buys1h: number, sells1h: number, trades24h: number, traders24h: number,
 *   mcapUsd: number, lpUsd: number, priceChange24hPct: number,
 *   change1hPct: number, change2hPct: number, change4hPct: number,
 *   trendScore: number, trendLabel: string, buySellRatio24h: number, price: number,
 * }} IndexerTradingSnapshot
 */

function formatTrendPctLine(n) {
  if (!Number.isFinite(n)) return "—";
  const icon = n >= 0 ? "🚀" : "📉";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%${icon}`;
}

/**
 * Build rich embed for a single Bankr token (paste address, etc.).
 * @param {object} out - getTokenFees result
 * @param {string} tokenAddress
 * @param {{
 *   deployerFeedCount?: number|null,
 *   feeRecipientFeedCount?: number|null,
 *   bankrDeployCount?: number|null,
 *   bankrFeeRecipientCount?: number|null,
 *   indexerSnapshot?: IndexerTradingSnapshot | null,
 * }} [options]
 */
export function buildTokenDetailEmbed(out, tokenAddress, options = {}) {
  const launchUrl = bankrLaunchUrl(tokenAddress);
  const basescanTokenUrl = `${BASESCAN}/token/${tokenAddress}`;
  const name = out.name ?? "—";
  const symbol = out.symbol ?? "—";
  const launch = out.launch ?? null;
  const img = (launch?.imageUri || launch?.image) ? imageUrl(launch.imageUri || launch.image) : null;
  const deployFeed = options.bankrDeployCount ?? options.deployerFeedCount;
  const feeFeed = options.bankrFeeRecipientCount ?? options.feeRecipientFeedCount;

  const tokenLines = [
    `**Chain:** Base`,
    `**CA:** \`${tokenAddress}\``,
    `**Bankr:** [View Launch](${launchUrl})`,
  ];
  if (out.dexMetrics?.marketCap != null && out.formatUsd) {
    const mc = out.formatUsd(out.dexMetrics.marketCap);
    if (mc) tokenLines.push(`**Market Cap:** ${mc}`);
  }
  const idx = options.indexerSnapshot;
  const dexVolPositive = out.volumeUsd != null && Number(out.volumeUsd) > 0;
  if (dexVolPositive && out.formatUsd) {
    const vol = out.formatUsd(out.volumeUsd);
    if (vol) tokenLines.push(`**Volume:** ${vol}`);
  }
  if (idx?.vol24h > 0 && out.formatUsd) {
    const iv = out.formatUsd(idx.vol24h);
    const showIndexerVol = !dexVolPositive;
    if (iv && showIndexerVol) {
      const v1 = idx.vol1h > 0 ? ` · 1h: ${out.formatUsd(idx.vol1h)}` : "";
      tokenLines.push(`**Volume:** ${iv}${v1}`);
    }
  }
  const trades = out.dexMetrics?.trades24h;
  const dexHasTrades = trades && (trades.buys > 0 || trades.sells > 0);
  if (dexHasTrades) {
    tokenLines.push(`**24H:** 🟢 ${trades.buys} buys • 🔴 ${trades.sells} sells`);
  } else if (idx && idx.buyTx24h + idx.sellTx24h > 0) {
    tokenLines.push(`**24H:** 🟢 ${idx.buyTx24h} buys • 🔴 ${idx.sellTx24h} sells`);
  }

  let deployerVal = formatDeployerOrFeeForEmbed(launch?.deployer);
  const deployDisp = formatBankrRoleCountDisplay(deployFeed);
  if (deployDisp != null) {
    deployerVal = deployerVal === "—" ? `**Deploys:** ${deployDisp}` : `${deployerVal}\n**Deploys:** ${deployDisp}`;
  }
  let feeRecipientVal = formatDeployerOrFeeForEmbed(launch?.feeRecipient);
  const feeDisp = formatBankrRoleCountDisplay(feeFeed);
  if (feeDisp != null) {
    feeRecipientVal =
      feeRecipientVal === "—" ? `**Recipient:** ${feeDisp}` : `${feeRecipientVal}\n**Recipient:** ${feeDisp}`;
  }
  const fields = [
    { name: "Token", value: tokenLines.join("\n"), inline: false },
    { name: "Deployer", value: deployerVal.slice(0, 1024), inline: false },
    { name: "Fee Recipient", value: feeRecipientVal.slice(0, 1024), inline: false },
  ];

  if (launch?.tweetUrl) fields.push({ name: "Tweet", value: launch.tweetUrl, inline: false });
  if (launch?.websiteUrl || launch?.website) fields.push({ name: "Website", value: launch.websiteUrl || launch.website || "—", inline: true });

  if (idx && out.formatUsd) {
    const fmt = out.formatUsd;
    const lines = [];
    lines.push("📊 **Token Stats**");
    const priceStr =
      idx.price > 0 && idx.price < 0.01
        ? `$${idx.price.toExponential(2)}`
        : idx.price > 0
          ? `$${idx.price.toFixed(8).replace(/\.?0+$/, "")}`
          : "—";
    lines.push(`├ Price: ${priceStr} (${formatTrendPctLine(idx.priceChange24hPct)})`);
    if (idx.mcapUsd > 0) lines.push(`├ MC: ${fmt(idx.mcapUsd)}`);
    lines.push(
      `├ Vol: ${idx.vol24h > 0 ? fmt(idx.vol24h) : "—"}${idx.vol1h > 0 ? ` (1h: ${fmt(idx.vol1h)})` : ""}`
    );
    if (idx.lpUsd > 0) lines.push(`└ LP: ${fmt(idx.lpUsd)}`);
    else lines.push("└ LP: —");
    lines.push("");
    lines.push("📈 **Price Action**");
    lines.push(`├ 1H: ${formatTrendPctLine(idx.change1hPct)} (B:${idx.buys1h}/S:${idx.sells1h})`);
    lines.push(`├ 2H: ${formatTrendPctLine(idx.change2hPct)}`);
    lines.push(`├ 4H: ${formatTrendPctLine(idx.change4hPct)}`);
    lines.push("");
    lines.push("👥 **Trading Activity (24H)**");
    const tr = idx.traders24h > 0 ? String(idx.traders24h) : "N/A";
    lines.push(`├ Traders: ${tr}`);
    lines.push(`├ Trades: ${idx.trades24h > 0 ? idx.trades24h : "—"}`);
    const b = idx.buyTx24h;
    const se = idx.sellTx24h;
    const total = b + se;
    const pctB = total > 0 ? Math.round((b / total) * 100) : 0;
    lines.push(`└ B/S: ${pctB}% (${b}/${se})`);
    if (idx.trendLabel && idx.trendLabel !== "NOT_TRENDING") {
      lines.push("");
      lines.push(`**Trend:** ${idx.trendLabel} · ${idx.trendScore}/100`);
    }
    const value = lines.join("\n").slice(0, 1024);
    fields.push({ name: "Stats", value, inline: false });
  }

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

export const TELEGRAM_HTML_MAX = 4096;
/** Main token card body budget; fees HTML is appended after—Telegram sendMessage limit is {@link TELEGRAM_HTML_MAX}. */
const TELEGRAM_TOKEN_BODY_MAX = 3600;

/** Escape text for Telegram HTML parse_mode. */
export function escapeTelegramHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Send HTML to any Telegram chat. Personal DMs must use skipAllowedCheck: true (TELEGRAM_ALLOWED_CHAT_IDS is for channel posts).
 * @param {string|number} chatId
 * @param {string} html
 * @param {{ skipAllowedCheck?: boolean, reply_markup?: object }} [options]
 */
export async function sendTelegramHtmlToChat(chatId, html, options = {}) {
  if (!TELEGRAM_TOKEN || chatId == null || chatId === "") return;
  if (!options.skipAllowedCheck && !allowedTelegramChat(chatId)) return;
  const text = String(html || "").slice(0, TELEGRAM_HTML_MAX);
  if (!text) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(options.reply_markup ? { reply_markup: options.reply_markup } : {}),
      }),
    });
  } catch (e) {
    console.error("Telegram HTML chat send error:", e.message);
  }
}

function formatDeployerOrFeeForTelegramHtml(obj) {
  if (!obj) return "—";
  const wallet = obj.walletAddress ?? obj.wallet ?? null;
  const parts = [];
  if (wallet) {
    const wl = walletLink(wallet);
    parts.push(
      `<b>Wallet:</b> ${wl ? `<a href="${escapeTelegramHtml(wl)}">${escapeTelegramHtml(wallet)}</a>` : `<code>${escapeTelegramHtml(wallet)}</code>`}`
    );
  }
  const xUser = obj.xUsername ?? obj.x ?? null;
  if (xUser) {
    const u = String(xUser).replace(/^@/, "");
    const xp = xProfileUrl(xUser);
    parts.push(`<b>X:</b> <a href="${escapeTelegramHtml(xp)}">@${escapeTelegramHtml(u)}</a>`);
  }
  const fc = obj.farcasterUsername ?? obj.farcaster ?? obj.fcUsername ?? null;
  if (fc) {
    const fp = farcasterProfileUrl(fc);
    parts.push(`<b>Farcaster:</b> <a href="${escapeTelegramHtml(fp)}">${escapeTelegramHtml(fc)}</a>`);
  }
  return parts.length ? parts.join("\n") : "—";
}

/** Telegram HTML trade line: GMGN + BB + Sigma (Discord {@link buildTradeLinks} also includes FCW). */
export function buildTradeLinksHtml(tokenAddress) {
  const addr = (tokenAddress || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return "—";
  const gmgnUrl = `https://t.me/GMGN_swap_bot?start=i_${GMGN_REFERRAL}_c_${addr}`;
  const bbUrl = `https://t.me/based_eth_bot?start=r_${GMGN_REFERRAL}_b_${addr}`;
  const sigmaUrl = sigmaTelegramTradeUrl(addr);
  return (
    `💱 <b>Trade</b> ` +
    `<a href="${escapeTelegramHtml(gmgnUrl)}">GMGN</a> · ` +
    `<a href="${escapeTelegramHtml(bbUrl)}">BB</a> · ` +
    `<a href="${escapeTelegramHtml(sigmaUrl)}">Sigma</a>`
  );
}

function formatClaimableOneLinerTelegram(hookFees, symbol) {
  const DECIMALS = 18;
  const wethAmount = Number(hookFees.beneficiaryFees0) / 10 ** DECIMALS;
  const tokenAmount = Number(hookFees.beneficiaryFees1) / 10 ** DECIMALS;
  const hasWeth = hookFees.beneficiaryFees0 > 0n;
  const hasToken = hookFees.beneficiaryFees1 > 0n;
  if (!hasWeth && !hasToken) return null;
  function fmtToken(n) {
    if (n >= 1e9) return `${(n / 1e9).toFixed(0)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return n.toFixed(4);
  }
  const parts = [];
  if (hasWeth) parts.push(`${wethAmount.toFixed(3)} WETH`);
  if (hasToken) parts.push(`${fmtToken(tokenAmount)} ${symbol || "token"}`);
  return parts.length ? `${parts.join(" + ")} (57% creator share)` : null;
}

/** Fee block for Telegram (HTML), aligned with Discord paste embed fees field. */
export function buildPasteTokenFeesTelegramHtml(out) {
  const feeParts = [];
  const DEC = 18;
  const claimableLine =
    out.hookFees && (out.hookFees.beneficiaryFees0 > 0n || out.hookFees.beneficiaryFees1 > 0n)
      ? formatClaimableOneLinerTelegram(out.hookFees, out.symbol)
      : null;
  const hasIndexerFees =
    out.cumulatedFees &&
    (out.cumulatedFees.token0Fees != null ||
      out.cumulatedFees.token1Fees != null ||
      out.cumulatedFees.totalFeesUsd != null);
  const fmtT = (n) =>
    n >= 1e9 ? `${(n / 1e9).toFixed(0)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(0)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(4);

  if (hasIndexerFees) {
    const w = Number(out.cumulatedFees.token0Fees ?? 0) / 10 ** DEC;
    const t = Number(out.cumulatedFees.token1Fees ?? 0) / 10 ** DEC;
    if (out.cumulatedFees.token0Fees != null || out.cumulatedFees.token1Fees != null) {
      feeParts.push(`<b>Historical accrued:</b> WETH ${w.toFixed(4)} • ${escapeTelegramHtml(out.symbol ?? "Token")} ${fmtT(t)}`);
    }
    if (out.cumulatedFees.totalFeesUsd != null && out.formatUsd) {
      const usd = Number(out.cumulatedFees.totalFeesUsd);
      if (!Number.isNaN(usd) && usd >= 0 && usd < 1e12) {
        feeParts.push(`<b>Total (USD):</b> ${escapeTelegramHtml(out.formatUsd(out.cumulatedFees.totalFeesUsd) ?? String(out.cumulatedFees.totalFeesUsd))}`);
      }
    }
  }

  if (claimableLine) feeParts.push(`<b>Claimable:</b> ${escapeTelegramHtml(claimableLine)}`);

  const ev = out.claimedFromEvents;
  const eps = 1e-9;
  if (ev != null) {
    const claimedW = ev.claimedWeth ?? 0;
    const claimedT = ev.claimedToken ?? 0;
    if (claimedW > eps || claimedT > eps) {
      feeParts.push(`<b>Already claimed (on-chain):</b> WETH ${claimedW.toFixed(4)} • Token ${fmtT(claimedT)}`);
    }
    if (ev.count > 0) {
      feeParts.push("<b>Fee recipient has claimed for this pool:</b> Yes");
      if (out.lastClaimTxHash) {
        const txUrl = `https://basescan.org/tx/${out.lastClaimTxHash}`;
        feeParts.push(`<b>Claim tx:</b> <a href="${escapeTelegramHtml(txUrl)}">BaseScan</a>`);
      }
    }
  }

  if (hasIndexerFees && out.hookFees && (out.cumulatedFees.token0Fees != null || out.cumulatedFees.token1Fees != null)) {
    const w = Number(out.cumulatedFees.token0Fees ?? 0) / 10 ** DEC;
    const t = Number(out.cumulatedFees.token1Fees ?? 0) / 10 ** DEC;
    const cW = Number(out.hookFees.beneficiaryFees0) / 10 ** DEC;
    const cT = Number(out.hookFees.beneficiaryFees1) / 10 ** DEC;
    const totalAccrued = w + t;
    const totalClaimable = cW + cT;
    if (ev != null && ev.count > 0) {
      if (totalClaimable < eps) feeParts.push("<b>Status:</b> ALL CLAIMED");
      else if (totalClaimable < totalAccrued - eps) feeParts.push("<b>Status:</b> PARTIALLY CLAIMED");
      else feeParts.push("<b>Status:</b> UNCLAIMED");
    } else if (totalAccrued >= eps) {
      if (totalClaimable >= eps) feeParts.push("<b>Status:</b> UNCLAIMED");
      else if (totalClaimable < eps) feeParts.push("<b>Status:</b> ALL CLAIMED");
    }
  }

  const retrievedAt = new Date().toLocaleString("en-US", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/New_York",
  });
  if (feeParts.length > 0) {
    feeParts.push(`<i>Data retrieved: ${escapeTelegramHtml(retrievedAt)} ET</i>`);
    return `<b>Fees</b>\n${feeParts.join("\n")}`;
  }
  if (out.launch) {
    const lines = [];
    if (out.estimatedCreatorFeesUsd != null && out.estimatedCreatorFeesUsd > 0 && out.formatUsd) {
      lines.push(
        `<b>Estimated creator fees</b> (57% of 1.2% of volume): ${escapeTelegramHtml(out.formatUsd(out.estimatedCreatorFeesUsd) ?? "—")}`
      );
    }
    if (lines.length === 0) lines.push("No fee data yet recorded.");
    lines.push(`<i>Data retrieved: ${escapeTelegramHtml(retrievedAt)} ET</i>`);
    return `<b>Fees</b>\n${lines.join("\n")}`;
  }
  return "";
}

/**
 * Rich Telegram HTML for a token (same data as {@link buildTokenDetailEmbed}).
 * @param {object} out - getTokenFees result
 * @param {string} tokenAddress
 * @param {Parameters<typeof buildTokenDetailEmbed>[2]} options
 */
export function buildTokenDetailTelegramHtml(out, tokenAddress, options = {}) {
  if (out.error && !out.launch) {
    return `<b>Token</b>\n${escapeTelegramHtml(out.error)}`;
  }
  const launchUrl = bankrLaunchUrl(tokenAddress);
  const name = out.name ?? "—";
  const symbol = out.symbol ?? "—";
  const launch = out.launch ?? null;
  const deployFeed = options.bankrDeployCount ?? options.deployerFeedCount;
  const feeFeed = options.bankrFeeRecipientCount ?? options.feeRecipientFeedCount;
  const idx = options.indexerSnapshot;

  const lines = [];
  lines.push(`<b>Bankr • ${escapeTelegramHtml(name)} ($${escapeTelegramHtml(symbol)})</b>`);
  lines.push("");
  lines.push("<b>Token</b>");
  lines.push(`<b>Chain:</b> Base`);
  lines.push(`<b>CA:</b> <code>${escapeTelegramHtml(tokenAddress)}</code>`);
  lines.push(
    `<b>Bankr:</b> <a href="${escapeTelegramHtml(launchUrl)}">View Launch</a>`
  );

  if (out.dexMetrics?.marketCap != null && out.formatUsd) {
    const mc = out.formatUsd(out.dexMetrics.marketCap);
    if (mc) lines.push(`<b>Market Cap:</b> ${escapeTelegramHtml(mc)}`);
  }
  const dexVolPositive = out.volumeUsd != null && Number(out.volumeUsd) > 0;
  if (dexVolPositive && out.formatUsd) {
    const vol = out.formatUsd(out.volumeUsd);
    if (vol) lines.push(`<b>Volume:</b> ${escapeTelegramHtml(vol)}`);
  }
  if (idx?.vol24h > 0 && out.formatUsd) {
    const iv = out.formatUsd(idx.vol24h);
    const showIndexerVol = !dexVolPositive;
    if (iv && showIndexerVol) {
      const v1 = idx.vol1h > 0 ? ` · 1h: ${out.formatUsd(idx.vol1h)}` : "";
      lines.push(`<b>Volume:</b> ${escapeTelegramHtml(iv + v1)}`);
    }
  }
  const trades = out.dexMetrics?.trades24h;
  const dexHasTrades = trades && (trades.buys > 0 || trades.sells > 0);
  if (dexHasTrades) {
    lines.push(`<b>24H:</b> 🟢 ${trades.buys} buys • 🔴 ${trades.sells} sells`);
  } else if (idx && idx.buyTx24h + idx.sellTx24h > 0) {
    lines.push(`<b>24H:</b> 🟢 ${idx.buyTx24h} buys • 🔴 ${idx.sellTx24h} sells`);
  }

  if (launch && !idx) {
    lines.push("");
    lines.push(
      "<i>Extended pool stats (volume, price, trend, fees history) need the Doppler indexer to have this pool—same card logic as Discord.</i>"
    );
  }

  lines.push("");
  let deployerVal = formatDeployerOrFeeForTelegramHtml(launch?.deployer);
  const deployDisp = formatBankrRoleCountDisplay(deployFeed);
  if (deployDisp != null) {
    deployerVal =
      deployerVal === "—"
        ? `<b>Deploys:</b> ${escapeTelegramHtml(deployDisp)}`
        : `${deployerVal}\n<b>Deploys:</b> ${escapeTelegramHtml(deployDisp)}`;
  }
  let feeRecipientVal = formatDeployerOrFeeForTelegramHtml(launch?.feeRecipient);
  const feeDisp = formatBankrRoleCountDisplay(feeFeed);
  if (feeDisp != null) {
    feeRecipientVal =
      feeRecipientVal === "—"
        ? `<b>Recipient:</b> ${escapeTelegramHtml(feeDisp)}`
        : `${feeRecipientVal}\n<b>Recipient:</b> ${escapeTelegramHtml(feeDisp)}`;
  }
  lines.push("<b>Deployer</b>");
  lines.push(deployerVal);
  lines.push("");
  lines.push("<b>Fee Recipient</b>");
  lines.push(feeRecipientVal);

  if (launch?.tweetUrl) {
    lines.push("");
    lines.push(`<b>Tweet:</b> <a href="${escapeTelegramHtml(launch.tweetUrl)}">link</a>`);
  }
  const web = launch?.websiteUrl || launch?.website;
  if (web) {
    lines.push("");
    lines.push(`<b>Website:</b> <a href="${escapeTelegramHtml(web)}">${escapeTelegramHtml(web)}</a>`);
  }

  if (idx && out.formatUsd) {
    const fmt = out.formatUsd;
    const sl = [];
    sl.push("📊 <b>Token Stats</b>");
    const priceStr =
      idx.price > 0 && idx.price < 0.01
        ? `$${idx.price.toExponential(2)}`
        : idx.price > 0
          ? `$${idx.price.toFixed(8).replace(/\.?0+$/, "")}`
          : "—";
    sl.push(`├ Price: ${escapeTelegramHtml(priceStr)} (${escapeTelegramHtml(formatTrendPctLine(idx.priceChange24hPct))})`);
    if (idx.mcapUsd > 0) sl.push(`├ MC: ${escapeTelegramHtml(fmt(idx.mcapUsd))}`);
    sl.push(
      `├ Vol: ${idx.vol24h > 0 ? escapeTelegramHtml(fmt(idx.vol24h)) : "—"}${idx.vol1h > 0 ? ` (1h: ${escapeTelegramHtml(fmt(idx.vol1h))})` : ""}`
    );
    if (idx.lpUsd > 0) sl.push(`└ LP: ${escapeTelegramHtml(fmt(idx.lpUsd))}`);
    else sl.push("└ LP: —");
    sl.push("");
    sl.push("📈 <b>Price Action</b>");
    sl.push(
      `├ 1H: ${escapeTelegramHtml(formatTrendPctLine(idx.change1hPct))} (B:${idx.buys1h}/S:${idx.sells1h})`
    );
    sl.push(`├ 2H: ${escapeTelegramHtml(formatTrendPctLine(idx.change2hPct))}`);
    sl.push(`├ 4H: ${escapeTelegramHtml(formatTrendPctLine(idx.change4hPct))}`);
    sl.push("");
    sl.push("👥 <b>Trading Activity (24H)</b>");
    const tr = idx.traders24h > 0 ? String(idx.traders24h) : "N/A";
    sl.push(`├ Traders: ${escapeTelegramHtml(tr)}`);
    sl.push(`├ Trades: ${idx.trades24h > 0 ? idx.trades24h : "—"}`);
    const b = idx.buyTx24h;
    const se = idx.sellTx24h;
    const total = b + se;
    const pctB = total > 0 ? Math.round((b / total) * 100) : 0;
    sl.push(`└ B/S: ${pctB}% (${b}/${se})`);
    if (idx.trendLabel && idx.trendLabel !== "NOT_TRENDING") {
      sl.push("");
      sl.push(`<b>Trend:</b> ${escapeTelegramHtml(idx.trendLabel)} · ${idx.trendScore}/100`);
    }
    lines.push("");
    lines.push("<b>Stats</b>");
    lines.push(sl.join("\n"));
  }

  lines.push("");
  lines.push(buildTradeLinksHtml(tokenAddress));

  let text = lines.join("\n");
  if (text.length > TELEGRAM_TOKEN_BODY_MAX) text = `${text.slice(0, TELEGRAM_TOKEN_BODY_MAX - 20)}…`;
  return text;
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
    const deployN = launch.bankrDeployCount ?? launch.deployCount;
    const deployDisp = formatBankrRoleCountDisplay(deployN);
    if (deployDisp != null) {
      parts.push(`**Deploys:** ${deployDisp}`);
    }
    launcherValue = parts.join("\n");
  }

  const fields = [
    { name: "Token", value: `${launch.name} ($${launch.symbol})`, inline: true },
    { name: "CA", value: `\`${launch.tokenAddress}\``, inline: true },
  ];
  if (Array.isArray(launch.watchMatchReasons) && launch.watchMatchReasons.length > 0) {
    let v = launch.watchMatchReasons.map((r) => `• ${r}`).join("\n");
    if (v.length > 1024) v = `${v.slice(0, 1021)}…`;
    fields.push({ name: "Matched because", value: v, inline: false });
  }
  fields.push({ name: "Launcher", value: launcherValue, inline: false });

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
    let feeVal = bens.trim() ? bens : "—";
    const feeRecN = launch.bankrFeeRecipientCount ?? launch.feeRecipientDeployCount;
    const feeDisp = formatBankrRoleCountDisplay(feeRecN);
    if (feeDisp != null) {
      feeVal = `${feeVal}\n**Recipient:** ${feeDisp}`;
    }
    fields.push({ name: "Fee recipient", value: feeVal.slice(0, 1024), inline: false });
  }
  if (launch.deployedAtMsFromBankr != null && Number.isFinite(launch.deployedAtMsFromBankr)) {
    const sec = Math.floor(launch.deployedAtMsFromBankr / 1000);
    fields.push({
      name: "Deployed",
      value: `<t:${sec}:F> · <t:${sec}:R>`,
      inline: true,
    });
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

/** Normalize topic/thread ID for Telegram (forum topic). Can be number or numeric string. */
function telegramThreadId(v) {
  if (v == null) return undefined;
  const n = typeof v === "number" && Number.isInteger(v) ? v : parseInt(String(v).trim(), 10);
  return Number.isNaN(n) ? undefined : n;
}

/** Bankr deploy count for launcher, else local feed count (notify cycle). */
function telegramDeploysCountDisplay(launch) {
  return formatBankrRoleCountDisplay(launch.bankrDeployCount ?? launch.deployCount);
}

/** Bankr fee-recipient token count, else local feed count. */
function telegramRecipientCountDisplay(launch) {
  return formatBankrRoleCountDisplay(launch.bankrFeeRecipientCount ?? launch.feeRecipientDeployCount);
}

/** Build Token / CA / Launcher / Fee recipient block for Telegram (Markdown), matching Discord embed.
 * @param {object} launch - Launch object (name, symbol, tokenAddress, launcher, launcherX, beneficiaries).
 * @param {{ skipToken?: boolean }} [opts] - If skipToken true, omit Token line (caller adds link separately).
 */
function formatLaunchBodyForTelegram(launch, opts = {}) {
  const name = escapeMarkdown(launch.name || "—");
  const symbol = escapeMarkdown(launch.symbol || "—");
  const ca = launch.tokenAddress ? String(launch.tokenAddress) : "—";
  const lines = [];
  if (!opts.skipToken) {
    lines.push("*Token*", `${name} ($${symbol})`, "", "");
  }
  lines.push("*CA*", `\`${ca}\``, "");
  let launcherValue = "—";
  if (launch.launcher) {
    const parts = [];
    if (launch.launcherX) {
      const xUrl = xProfileUrl(launch.launcherX);
      const handle = String(launch.launcherX).replace(/^@/, "");
      parts.push(xUrl ? `X: [@${handle}](${xUrl})` : `X: @${handle}`);
    }
    if (launch.launcherFarcaster) {
      const fcUrl = farcasterProfileUrl(launch.launcherFarcaster);
      parts.push(fcUrl ? `Farcaster: [${escapeMarkdown(launch.launcherFarcaster)}](${fcUrl})` : `Farcaster: ${escapeMarkdown(launch.launcherFarcaster)}`);
    }
    const wUrl = walletLink(launch.launcher);
    parts.push(wUrl ? `Wallet: [${launch.launcher}](${wUrl})` : `Wallet: ${launch.launcher}`);
    const dep = telegramDeploysCountDisplay(launch);
    if (dep != null) parts.push(`*Deploys:* ${dep}`);
    launcherValue = parts.join("\n");
  }
  lines.push("*Launcher*", launcherValue, "");
  if (launch.beneficiaries && launch.beneficiaries.length) {
    const b = launch.beneficiaries[0];
    const addr = typeof b === "object" ? b.beneficiary || b.address : b;
    const parts = [];
    if (b.xUsername) {
      const xUrl = xProfileUrl(b.xUsername);
      const handle = String(b.xUsername).replace(/^@/, "");
      parts.push(xUrl ? `X: [@${handle}](${xUrl})` : `X: @${handle}`);
    }
    if (b.farcaster) {
      const fcUrl = farcasterProfileUrl(b.farcaster);
      parts.push(fcUrl ? `Farcaster: [${escapeMarkdown(b.farcaster)}](${fcUrl})` : `Farcaster: ${escapeMarkdown(b.farcaster)}`);
    }
    if (addr) {
      const wUrl = walletLink(addr);
      parts.push(wUrl ? `Wallet: [${addr}](${wUrl})` : `Wallet: ${addr}`);
    }
    const rec = telegramRecipientCountDisplay(launch);
    if (rec != null) parts.push(`*Recipient:* ${rec}`);
    lines.push("*Fee recipient*", parts.length ? parts.join("\n") : "—", "");
  } else {
    lines.push("*Fee recipient*", "—", "");
  }
  return lines.join("\n");
}

export async function sendTelegram(launch, options = {}) {
  const chatId = options.chatId ?? TELEGRAM_CHAT;
  if (!TELEGRAM_TOKEN || !chatId) return;
  if (!options.skipAllowedCheck && !allowedTelegramChat(chatId)) return;
  const messageThreadId = telegramThreadId(options.messageThreadId);
  const launchUrl = bankrLaunchUrl(launch.tokenAddress);
  const basescanTokenUrl = `${BASESCAN}/token/${launch.tokenAddress}`;

  let text = options.prependMarkdown ? `${options.prependMarkdown}\n\n` : "";
  text += `*New launch: ${escapeMarkdown(launch.name)} ($${escapeMarkdown(launch.symbol)})*\n\n`;
  text += `*Token*\n${escapeMarkdown(launch.name)} ($${escapeMarkdown(launch.symbol)})\n\n`;
  text += `[View on Bankr](${launchUrl}) | [Basescan](${basescanTokenUrl})\n\n`;
  text += `*CA*\n\`${launch.tokenAddress}\`\n\n`;

  if (launch.launcher) {
    text += `*Launcher*\n`;
    if (launch.launcherX) text += `  X: [@${escapeMarkdown(launch.launcherX)}](${xProfileUrl(launch.launcherX)})\n`;
    if (launch.launcherFarcaster) text += `  Farcaster: [${escapeMarkdown(launch.launcherFarcaster)}](${farcasterProfileUrl(launch.launcherFarcaster)})\n`;
    text += `  Wallet: [${launch.launcher}](${walletLink(launch.launcher)})\n`;
    const dep = telegramDeploysCountDisplay(launch);
    if (dep != null) text += `  *Deploys:* ${dep}\n`;
    text += `\n`;
  }

  if (launch.beneficiaries?.length) {
    text += `*Fee recipient*\n`;
    for (const b of launch.beneficiaries) {
      const addr = typeof b === "object" ? b.beneficiary || b.address : b;
      if (b.xUsername) text += `  X: [@${escapeMarkdown(b.xUsername)}](${xProfileUrl(b.xUsername)})\n`;
      if (b.farcaster) text += `  Farcaster: [${escapeMarkdown(b.farcaster)}](${farcasterProfileUrl(b.farcaster)})\n`;
      text += `  Wallet: [${addr}](${walletLink(addr)})\n`;
    }
    const rec = telegramRecipientCountDisplay(launch);
    if (rec != null) text += `  *Recipient:* ${rec}\n`;
    text += `\n`;
  }

  if (launch.deployedAtMsFromBankr != null && Number.isFinite(launch.deployedAtMsFromBankr)) {
    const deployed = new Date(launch.deployedAtMsFromBankr);
    text += `*Deployed*\n\`${deployed.toUTCString().replace(" GMT", " UTC")}\`\n\n`;
  }

  if (launch.tweetUrl) text += `*Tweet:* ${launch.tweetUrl}\n`;
  if (launch.website) text += `*Website:* ${launch.website}\n`;

  const img = launch.image ? imageUrl(launch.image) : null;
  const basePayload = { chat_id: chatId, disable_web_page_preview: true, ...(messageThreadId != null && { message_thread_id: messageThreadId }) };
  const replyMarkup = telegramTradeKeyboard(launch.tokenAddress);
  const payloadExtra = replyMarkup ? { reply_markup: replyMarkup } : {};

  try {
    if (img) {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...basePayload, ...payloadExtra, photo: img, caption: text, parse_mode: "Markdown" }),
      });
    } else {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...basePayload, ...payloadExtra, text, parse_mode: "Markdown" }),
      });
    }
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}

/** Send a short "hot" or "trending" ping to Telegram.
 * Hot: 5–10+ buys in first minute and/or 20+ holders. Trending: ~30m / 5m / 1h buy lines from DexScreener.
 * options.messageThreadId — forum topic ID. options.trending — use "TRENDING" title and buy lines. */
export async function sendTelegramHotPing(launch, stats, options = {}) {
  const chatId = options.chatId ?? TELEGRAM_CHAT;
  if (!TELEGRAM_TOKEN || !chatId || !stats) return;
  if (!options.skipAllowedCheck && !allowedTelegramChat(chatId)) return;
  const messageThreadId = telegramThreadId(options.messageThreadId);
  const {
    hotByBuys,
    hotByHolders,
    hotByIndexerVol,
    trendingByIndexerVol,
    buysFirstMin,
    holderCount,
    isTrending,
    buys5m,
    buys30m,
    buys1h,
    indexerVol1h,
    indexerVol24h,
  } = stats;
  const trending = options.trending === true || isTrending === true;
  if (trending) {
    const hasDexTrend =
      (buys30m ?? 0) > 0 || (buys5m ?? 0) > 0 || (buys1h ?? 0) > 0;
    if (!hasDexTrend && !trendingByIndexerVol) return;
  } else if (!hotByBuys && !hotByHolders && !hotByIndexerVol) return;
  const launchUrl = bankrLaunchUrl(launch.tokenAddress);
  let line;
  let title;
  if (trending) {
    title = "📈 *TRENDING*";
    const parts = [
      `📈 ${buys30m ?? 0} buys (~30m) · ${buys5m ?? 0} (5m) · ${buys1h ?? 0} (1h)`,
    ];
    if (trendingByIndexerVol && indexerVol24h != null && Number(indexerVol24h) > 0) {
      const v = formatUsd(indexerVol24h) ?? String(indexerVol24h);
      parts.push(`Doppler 24h vol ${v}`);
    }
    line = parts.join(" · ");
  } else {
    const parts = [];
    if (hotByBuys) parts.push(`🔥 ${buysFirstMin ?? 0}+ buys in first minute`);
    if (hotByHolders) parts.push(`👥 ${holderCount ?? 0}+ holders`);
    if (hotByIndexerVol && indexerVol1h != null && Number(indexerVol1h) > 0) {
      const v = formatUsd(indexerVol1h) ?? String(indexerVol1h);
      parts.push(`📊 Doppler ~1h vol ${v}`);
    }
    line = parts.join(" · ");
    title = "🔔 *HOT TOKEN*";
  }
  const fresh = await getHotTokenStats(launch.tokenAddress).catch(() => null);
  const bankrMs =
    launch.deployedAtMsFromBankr != null && Number.isFinite(launch.deployedAtMsFromBankr)
      ? launch.deployedAtMsFromBankr
      : null;
  const deployedMs =
    bankrMs ??
    fresh?.deployedAtMs ??
    (stats.deployedAtMs != null && Number.isFinite(stats.deployedAtMs) ? stats.deployedAtMs : null);
  const mcStr =
    stats.marketCapFormatted ||
    (fresh?.marketCap != null && Number.isFinite(fresh.marketCap) ? formatUsd(fresh.marketCap) : null);

  const body = formatLaunchBodyForTelegram(launch, { skipToken: true });
  const tokenLink = `[${escapeMarkdown(launch.name)} ($${escapeMarkdown(launch.symbol)})](${launchUrl})`;
  const extras = [];
  if (mcStr) extras.push(`💰 MC: ${escapeMarkdown(mcStr)}`);
  if (deployedMs != null) {
    extras.push(`🕐 Deployed: \`${new Date(deployedMs).toISOString()}\``);
  }
  const extraBlock = extras.length ? `${extras.join("\n")}\n\n` : "";
  const prefix = options.prependMarkdown ? `${options.prependMarkdown}\n\n` : "";
  const text = `${prefix}${title}\n\n${tokenLink}\n\n${extraBlock}${body}\n${line}`;
  const replyMarkup = telegramTradeKeyboard(launch.tokenAddress);
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    ...(messageThreadId != null && { message_thread_id: messageThreadId }),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    const messageId = data?.result?.message_id;
    if (messageId != null && options.skipPin !== true) {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/pinChatMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          disable_notification: false,
        }),
      }).catch((e) => console.error("Telegram pin hot message:", e.message));
    }
  } catch (e) {
    console.error("Telegram hot ping error:", e.message);
  }
}

/** Send a Bankr fee-claim alert to Telegram (same idea as Discord claim firehose).
 * @param {{ poolSymbol?: string, poolToken?: string, amountFormatted?: string, amount?: string, txHash?: string }} claim
 * @param {{ chatId?: string, messageThreadId?: number | string }} [options] - Default chatId from TELEGRAM_CLAIM_CHAT_ID or TELEGRAM_CHAT_ID
 */
export async function sendTelegramClaim(claim, options = {}) {
  const chatId = options.chatId ?? process.env.TELEGRAM_CLAIM_CHAT_ID ?? TELEGRAM_CHAT;
  if (!TELEGRAM_TOKEN || !chatId) return;
  if (!options.skipAllowedCheck && !allowedTelegramChat(chatId)) return;
  const messageThreadId = telegramThreadId(options.messageThreadId ?? process.env.TELEGRAM_CLAIM_TOPIC_ID);
  const symbol = (claim.poolSymbol ?? "Token").trim();
  const tokenAddr = (claim.poolToken ?? "").trim();
  const amt = claim.amountFormatted ?? claim.amount ?? "0";
  const bankrUrl = tokenAddr ? bankrLaunchUrl(tokenAddr) : null;
  const txUrl = claim.txHash ? `${BASESCAN}/tx/${claim.txHash}` : null;
  // Token name links to Bankr; Token CA full address for search/copy
  const titleLink = bankrUrl ? `[$${escapeMarkdown(symbol)}](${bankrUrl})` : `*$${escapeMarkdown(symbol)}*`;
  let text = options.prependMarkdown ? `${options.prependMarkdown}\n\n` : "";
  text += `💰 ${titleLink} claimed\n\n`;
  if (tokenAddr) text += `Token CA: \`${tokenAddr}\`\n`;
  text += `Fees: ${amt} WETH\n`;
  if (txUrl) text += `TX: [BaseScan](${txUrl})`;
  const replyMarkup = tokenAddr ? telegramTradeKeyboard(tokenAddr) : null;
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };
  if (messageThreadId != null) payload.message_thread_id = messageThreadId;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("Telegram claim send error:", e.message);
  }
}

/** Run one notify cycle: fetch, filter, update seen. Returns new launches (enriched) and totalCount.
 * @param {{ bankrApiKey?: string }} [options] - When provided (e.g. from Discord tenant), use this key for Bankr API so cycle works without env key.
 */
export async function runNotifyCycle(options = {}) {
  const cycleApiKey = defaultBankrApiKey(options.bankrApiKey);
  const seenArr = await loadSeen();
  const deployCounts = await loadDeployCounts();
  const feeRecipientCounts = await loadFeeRecipientCounts();

  const source = cycleApiKey && CHAIN_ID === 8453 ? "Bankr API" : `indexer=${DOPPLER_INDEXER_URL}`;
  console.log(`Fetching launches (chainId=${CHAIN_ID}, ${source})...`);
  const launches = await fetchLaunches(cycleApiKey);
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
    const feeAddrs = (l.beneficiaries || [])
      .map((b) => (typeof b === "object" ? (b.beneficiary ?? b.address ?? b.wallet) : b))
      .map((a) =>
        a && typeof a === "string" && /^0x[a-fA-F0-9]{40}$/.test(a.trim()) ? a.trim().toLowerCase() : null
      )
      .filter(Boolean);
    for (const fa of feeAddrs) {
      if (l.tokenAddress) {
        if (!feeRecipientCounts[fa]) feeRecipientCounts[fa] = new Set();
        feeRecipientCounts[fa].add(l.tokenAddress.toLowerCase());
      }
    }
  }
  await saveDeployCounts(deployCounts);
  await saveFeeRecipientCounts(feeRecipientCounts);

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
    if (FILTER_FEE_RECIPIENT_HAS_X) {
      const feeX = l.beneficiaries?.[0]?.xUsername ? String(l.beneficiaries[0].xUsername).trim().replace(/^@/, "") : null;
      if (!feeX) return false;
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
  if (hasWatchList && watchWallet.size > 0 && newLaunches.length > 0 && cycleApiKey && CHAIN_ID === 8453) {
    let fetched = 0;
    for (const launch of newLaunches) {
      if (fetched >= SINGLE_LAUNCH_FETCH_LIMIT) break;
      const hasWallet = launch.launcher || (launch.beneficiaries?.length > 0);
      if (hasWallet) continue;
      const raw = await fetchSingleBankrLaunch(launch.tokenAddress, cycleApiKey);
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
    const b0 = launch.beneficiaries?.[0];
    const feeW =
      typeof b0 === "object" && b0
        ? (b0.beneficiary ?? b0.address ?? b0.wallet)
        : b0;
    const feeAddr =
      feeW && typeof feeW === "string" && /^0x[a-fA-F0-9]{40}$/.test(feeW.trim())
        ? feeW.trim().toLowerCase()
        : null;
    const feeRecipientDeployCount = feeAddr ? feeRecipientCounts[feeAddr]?.size : null;
    return {
      ...launch,
      deployCount: count ?? undefined,
      feeRecipientDeployCount: feeRecipientDeployCount != null && feeRecipientDeployCount >= 1 ? feeRecipientDeployCount : undefined,
      isWatchMatch: isWatchMatch(launch),
      passedFilters: passesFilters(launch),
    };
  });

  /** Bankr API counts for Telegram/Discord parity (Deploys / Recipient). Cached in lookup-deployer. */
  const withBankrCounts =
    cycleApiKey && CHAIN_ID === 8453
      ? await Promise.all(enriched.map((l) => enrichLaunchWithBankrRoleCounts(l, { bankrApiKey: cycleApiKey })))
      : enriched;

  await saveSeen(seenArr);
  for (const l of withBankrCounts) {
    const fee0 = l.beneficiaries?.[0] && (typeof l.beneficiaries[0] === "object" ? (l.beneficiaries[0].beneficiary ?? l.beneficiaries[0].address) : l.beneficiaries[0]);
    const launcherShort = l.launcher ? `${l.launcher.slice(0, 6)}..${l.launcher.slice(-4)}` : "—";
    const feeShort = fee0 ? `${String(fee0).slice(0, 6)}..${String(fee0).slice(-4)}` : "—";
    if (hasWatchList) console.log(`Notifying: ${l.name} ($${l.symbol}) launcher=${launcherShort} fee=${feeShort}${l.isWatchMatch ? " [WATCH MATCH]" : ""}`);
    else console.log(`Notifying: ${l.name} ($${l.symbol})${l.isWatchMatch ? " [watch]" : ""}`);
  }
  console.log(`Done. ${withBankrCounts.length} new, ${launches.length} total (seen: ${seenArr.length}). Set SEEN_FILE=/data/bankr-seen.json on a volume so seen list persists across deploys.`);
  return { newLaunches: withBankrCounts, totalCount: launches.length };
}

async function main() {
  if (!DISCORD_WEBHOOK && !(TELEGRAM_TOKEN && TELEGRAM_CHAT)) {
    console.error(
      "Set DISCORD_WEBHOOK_URL and/or TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID"
    );
    process.exit(1);
  }

  const firehoseThreadId = telegramThreadId(process.env.TELEGRAM_TOPIC_FIREHOSE);
  const tgAfterDiscordMs = Math.max(
    0,
    parseInt(process.env.TELEGRAM_OUTBOUND_DELAY_MS ?? process.env.TELEGRAM_HOT_PING_DELAY_MS ?? "30000", 10)
  );
  const { newLaunches } = await runNotifyCycle();
  for (const launch of newLaunches) {
    await sendDiscordWebhook(launch);
    if (tgAfterDiscordMs <= 0) {
      await sendTelegram(launch, { messageThreadId: firehoseThreadId });
    } else {
      setTimeout(
        () => void sendTelegram(launch, { messageThreadId: firehoseThreadId }).catch(() => {}),
        tgAfterDiscordMs
      );
    }
  }
}

const isNotifyCli =
  typeof process !== "undefined" &&
  process.argv[1] &&
  /(?:^|[\\/])notify\.js$/.test(String(process.argv[1]).replace(/\\/g, "/"));
if (isNotifyCli) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
