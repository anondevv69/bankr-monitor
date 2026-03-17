#!/usr/bin/env node
import "dotenv/config";
/**
 * Discord bot with /watch commands to manage the Bankr launch watch list.
 * Add/remove X, Farcaster, wallet, keyword watchers. Runs the notify loop in the background.
 * Launch alerts are posted by the bot to DISCORD_ALERT_CHANNEL_ID or DISCORD_WATCH_ALERT_CHANNEL_ID (not webhook).
 *
 * Env: DISCORD_BOT_TOKEN (required)
 *   DISCORD_ALERT_CHANNEL_ID    - channel for all launch alerts (fallback)
 *   DISCORD_WATCH_ALERT_CHANNEL_ID - channel for watch-list matches (wallet/X/FC/keyword)
 * Channel IDs are usually set per server via /setup; env vars are optional fallbacks.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ComponentType,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { addWallet, removeWallet, addKeyword, removeKeyword, list } from "./watch-store.js";
import {
  getTenant,
  setTenant,
  listActiveTenantGuildIds,
  getWatchListForGuild,
  getWatchListDisplayForGuild,
  updateWatchListForGuild,
  updateWatchListEntryName,
  getClaimWatchTokens,
  addClaimWatchToken,
  removeClaimWatchToken,
  getClaimTokenChannels,
  addClaimTokenChannel,
  removeClaimTokenChannel,
  getTenantStats,
} from "./tenant-store.js";
import {
  runNotifyCycle,
  buildLaunchEmbed,
  buildTokenDetailEmbed,
  sendTelegram,
  sendTelegramHotPing,
  sendTelegramClaim,
  fetchLaunchByTokenAddress,
} from "./notify.js";
import { lookupByDeployerOrFee, resolveHandleToWallet } from "./lookup-deployer.js";
import { buildDeployBody, callBankrDeploy } from "./deploy-token.js";
import { getTokenFees, getHotTokenStats, formatUsd } from "./token-stats.js";
import { fetchTopFeeEarners, fetchLatestFeeClaim } from "./whales.js";
import { getFeesSummaryOnChainOnly } from "./fees-for-wallet.js";
import { getClaimState, setClaimState } from "./claim-watch-store.js";
import { start as startDopplerClaimWatcher, onFeeClaim, getWalletClaims, getTokenClaims } from "./watchers/dopplerClaimWatcher.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.DISCORD_BOT_TOKEN;
/** Optional: post every Bankr launch here (unfiltered firehose). */
const ALL_LAUNCHES_CHANNEL_ID = process.env.DISCORD_ALL_LAUNCHES_CHANNEL_ID;
/** Optional: post only launches that pass global filters (same as notify.js). If unset, only watch/all channels used. */
const ALERT_CHANNEL_ID = process.env.DISCORD_ALERT_CHANNEL_ID;
const WATCH_ALERT_CHANNEL_ID = process.env.DISCORD_WATCH_ALERT_CHANNEL_ID;
const HOT_LAUNCH_ALERT_CHANNEL_ID = process.env.DISCORD_HOT_LAUNCH_ALERT_CHANNEL_ID || null;
const HOT_LAUNCH_ENABLED = process.env.HOT_LAUNCH_ENABLED !== "false" && process.env.HOT_LAUNCH_ENABLED !== "0";
const TRENDING_ALERT_CHANNEL_ID = process.env.DISCORD_TRENDING_ALERT_CHANNEL_ID || null;
const TRENDING_ENABLED = process.env.TRENDING_ENABLED === "true" || process.env.TRENDING_ENABLED === "1";
/** Optional: real-time Doppler fee-claim firehose (Alchemy WebSocket). Set ALCHEMY_KEY + this channel to post every claim. */
const CLAIM_FIREHOSE_CHANNEL_ID = process.env.DISCORD_CLAIM_FIREHOSE_CHANNEL_ID || null;
/** Optional: token → channel routing. JSON object: { "0x...ba3": "discordChannelId", ... }. Claims for a token are also sent to its channel. */
let CLAIM_TOKEN_CHANNELS = {};
try {
  if (process.env.DISCORD_CLAIM_TOKEN_CHANNELS) {
    const raw = JSON.parse(process.env.DISCORD_CLAIM_TOKEN_CHANNELS);
    if (raw && typeof raw === "object") {
      CLAIM_TOKEN_CHANNELS = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [String(k).toLowerCase(), String(v)])
      );
    }
  }
} catch (_) {}
const DEBUG_WEBHOOK_URL = process.env.DISCORD_DEBUG_WEBHOOK_URL;
const INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || "60000", 10);
const LOOKUP_PAGE_SIZE = Math.min(Math.max(parseInt(process.env.LOOKUP_PAGE_SIZE || "5", 10), 3), 25);
const LOOKUP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const lookupCache = new Map(); // messageId -> { matches, query, by, searchUrl, totalCount, possiblyCapped, createdAt }

/** When true, /deploy is not registered and is hidden from help. Deploy handler code remains so it can be re-enabled by setting to false. */
const HIDE_DEPLOY_COMMAND = true;

/** Hot launch ping: min buys in first minute to trigger (DexScreener m5 at ~65s ≈ first minute). Set to 0 to disable. Use 5–10 for "first minute" pings. */
const HOT_LAUNCH_MIN_BUYS_FIRST_MIN = Math.max(
  0,
  parseInt(process.env.HOT_LAUNCH_MIN_BUYS_FIRST_MIN || process.env.HOT_LAUNCH_MIN_BUYS_5M || "5", 10)
);
/** Hot launch ping: min holder count to trigger "20+ holders" (indexer). Set to 0 to disable. */
const HOT_LAUNCH_MIN_HOLDERS = Math.max(0, parseInt(process.env.HOT_LAUNCH_MIN_HOLDERS || "20", 10));
/** Trending: min buys in 5m to post to trending channel/topic (separate from hot). Set to 0 to disable. Default 15. */
const TRENDING_MIN_BUYS_5M = Math.max(0, parseInt(process.env.TRENDING_MIN_BUYS_5M || "15", 10));
/** Trending: min buys in 1h to post to trending (API has 5m/1h only; 1h used for "50 in 30m" style). Set to 0 to disable. Default 50. */
const TRENDING_MIN_BUYS_1H = Math.max(0, parseInt(process.env.TRENDING_MIN_BUYS_1H || "50", 10));
/** Delay (ms) after first ping before checking hot stats. Default 65s so DexScreener m5 ≈ buys in first minute. */
const HOT_LAUNCH_DELAY_MS = Math.max(30_000, parseInt(process.env.HOT_LAUNCH_DELAY_MS || "65000", 10));
/** Extra delay (ms) before sending hot/trending pings to Telegram (after Discord). Default 60s so Telegram is ~1 min after Discord. */
const TELEGRAM_HOT_PING_DELAY_MS = Math.max(0, parseInt(process.env.TELEGRAM_HOT_PING_DELAY_MS || "60000", 10));
/** Role IDs to mention on hot launch ping (comma-separated). E.g. HOT_LAUNCH_DISCORD_ROLE_IDS=123,456 */
const HOT_LAUNCH_DISCORD_ROLE_IDS = (process.env.HOT_LAUNCH_DISCORD_ROLE_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => /^\d+$/.test(s));
/** If "true" or "1", include @everyone in hot ping. Default false — use role IDs so servers can assign who gets tagged. */
const HOT_LAUNCH_USE_EVERYONE =
  process.env.HOT_LAUNCH_USE_EVERYONE === "true" || process.env.HOT_LAUNCH_USE_EVERYONE === "1";

/** When true, env Telegram curated topic only gets launches where fee recipient has X. Does not affect Discord or tenant rules. */
const TELEGRAM_CURATED_FEE_RECIPIENT_HAS_X =
  process.env.TELEGRAM_CURATED_FEE_RECIPIENT_HAS_X === "true" || process.env.TELEGRAM_CURATED_FEE_RECIPIENT_HAS_X === "1";

function feeRecipientHasX(launch) {
  const x = launch.beneficiaries?.[0]?.xUsername;
  return x != null && String(x).trim().replace(/^@/, "").length > 0;
}

/** True if the user can change server config (setup, settings, watchlist, claim-watch, deploy). Requires Manage Server or Administrator in the guild. */
function canManageServer(interaction) {
  if (!interaction.guildId || !interaction.member) return false;
  const perms = interaction.member.permissions;
  return perms?.has(PermissionFlagsBits.ManageGuild) || perms?.has(PermissionFlagsBits.Administrator);
}

/** Send a line to the debug webhook (activity log). No-op if DISCORD_DEBUG_WEBHOOK_URL not set. */
function debugLogActivity(serverNameOrId, userTag, action, detail) {
  if (!DEBUG_WEBHOOK_URL) return;
  const server = serverNameOrId || "DM";
  const detailStr = detail != null ? String(detail).slice(0, 200) : "";
  const body = JSON.stringify({
    content: `\`[${server}]\` **${userTag}** · ${action}${detailStr ? ` · ${detailStr}` : ""}`,
  });
  fetch(DEBUG_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {});
}

/** Send an error to the debug webhook. No-op if DISCORD_DEBUG_WEBHOOK_URL not set. */
function debugLogError(err, context) {
  if (!DEBUG_WEBHOOK_URL) return;
  const message = err?.message ?? String(err);
  const stack = err?.stack?.slice(0, 800);
  const body = JSON.stringify({
    content: `**Error** ${context ? `(${context})` : ""}\n\`\`\`\n${message}${stack ? `\n${stack}` : ""}\n\`\`\``,
  });
  fetch(DEBUG_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {});
}

/** Send claimable-unavailable reason to debug webhook for easier debugging (RPC, pool ID, etc.). */
function debugLogClaimableUnavailable(tokenAddress, out, context = "fees") {
  if (!DEBUG_WEBHOOK_URL || !out?.claimableUnavailableReason) return;
  const rpc = process.env.RPC_URL_BASE || process.env.RPC_URL;
  const rpcHint = rpc ? `${rpc.replace(/\/\/[^/:]+@/, "//***@").slice(0, 45)}…` : "not set";
  const body = JSON.stringify({
    content: `**Claimable unavailable** \`${context}\`\nToken: \`${(tokenAddress || "").slice(0, 10)}…${(tokenAddress || "").slice(-6)}\`\nReason: \`${out.claimableUnavailableReason}\`\nRPC_URL_BASE: ${rpcHint}\nHas pool ID: ${out.hasPoolIdForHook ? "yes" : "no"}`,
  });
  fetch(DEBUG_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {});
}

function getLookupPagination(matches, page) {
  const totalPages = Math.ceil(matches.length / LOOKUP_PAGE_SIZE) || 1;
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const start = currentPage * LOOKUP_PAGE_SIZE;
  return { totalPages, currentPage, start, pageMatches: matches.slice(start, start + LOOKUP_PAGE_SIZE) };
}

function buildLookupEmbed(data, page) {
  const { matches, query, by, searchUrl, totalCount, possiblyCapped, resolvedWallet } = data;
  const total = totalCount > 0 ? totalCount : matches.length;
  const byLabel = by === "deployer" ? " (deployer)" : by === "fee" ? " (fee recipient)" : "";
  const { totalPages, currentPage, start, pageMatches } = getLookupPagination(matches, page);
  const walletLine = resolvedWallet ? `**Wallet:** \`${resolvedWallet}\`\n\n` : "";
  let description;
  let footer;
  if (total > matches.length) {
    description =
      walletLine +
      `**${total} token(s) associated** with this wallet · **Latest ${matches.length} we can show here.**\n` +
      `Click the link below to see all ${total} on Bankr.\n**[View all ${total} on site →](${searchUrl})**`;
    footer = { text: `Showing latest ${matches.length} of ${total} · Full list on Bankr` };
  } else if (possiblyCapped) {
    description = walletLine + `**At least ${matches.length} token(s)** · Latest we can show here.\n**[View full list on site →](${searchUrl})**`;
    footer = { text: "Full list on Bankr" };
  } else {
    description =
      walletLine +
      (totalPages > 1
        ? `**${total} token(s) associated** with this wallet · **5 per page.** Use Previous/Next below.\n**[View on site →](${searchUrl})**`
        : `**${total} token(s) associated** with this wallet.\n**[View on site →](${searchUrl})**`);
    footer =
      totalPages > 1
        ? { text: `Page ${currentPage + 1}/${totalPages} of ${matches.length} tokens` }
        : undefined;
  }
  return {
    color: 0x0052_ff,
    title: `Bankr lookup: ${query}${byLabel}`,
    description,
    fields: pageMatches.map((m, i) => {
      const num = start + i + 1;
      return {
        name: `${m.tokenName} ($${m.tokenSymbol})`,
        value: `CA: \`${m.tokenAddress}\`\n[Bankr](${m.bankrUrl})`,
        inline: true,
      };
    }),
    footer,
  };
}
function buildLookupButtons(data, page) {
  const { totalPages, currentPage } = getLookupPagination(data.matches, page);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("lookup:prev")
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage <= 0),
    new ButtonBuilder()
      .setCustomId("lookup:next")
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages - 1)
  );
  return [row];
}

if (!TOKEN) {
  console.error("DISCORD_BOT_TOKEN is required");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

async function registerCommands(appId) {
  const rest = new REST().setToken(TOKEN);
  const commands = [
    new SlashCommandBuilder()
      .setName("lookup")
      .setDescription("Search Bankr tokens by deployer or fee recipient (wallet, X, or Farcaster)")
      .addStringOption((o) =>
        o
          .setName("query")
          .setDescription("Wallet (0x...), X handle (@user or link), or Farcaster (user or link)")
          .setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName("by")
          .setDescription("Limit to deployer, fee recipient, or both")
          .setRequired(false)
          .addChoices(
            { name: "Deployer", value: "deployer" },
            { name: "Fee recipient", value: "fee" },
            { name: "Both (default)", value: "both" }
          )
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("wallet-lookup")
      .setDescription("Wallet lookup: get the wallet address for an X or Farcaster account")
      .addStringOption((o) =>
        o
          .setName("query")
          .setDescription("X handle (@user), Farcaster handle, or profile URL (e.g. x.com/gork)")
          .setRequired(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("fees-token")
      .setDescription("Show accrued/claimable fees for a Bankr token (by address or launch URL)")
      .addStringOption((o) =>
        o
          .setName("token")
          .setDescription("Token address (0x...) or Bankr launch URL (e.g. bankr.bot/launches/0x...)")
          .setRequired(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("bankr-whales")
      .setDescription("Top Bankr fee earners leaderboard (all-time)")
      .addIntegerOption((o) =>
        o
          .setName("limit")
          .setDescription("Number of entries (default 10, max 50)")
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(50)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("watch")
      .setDescription("Manage Bankr launch watch list")
      .addSubcommand((s) => s.setName("list").setDescription("Show current watch list"))
      .addSubcommand((s) =>
        s
          .setName("add")
          .setDescription("Add user to watch list")
          .addStringOption((o) =>
            o.setName("type").setDescription("Watch type").setRequired(true).addChoices(
              { name: "X (Twitter)", value: "x" },
              { name: "Farcaster", value: "fc" },
              { name: "Wallet", value: "wallet" },
              { name: "Keyword", value: "keyword" }
            )
          )
          .addStringOption((o) =>
            o.setName("value").setDescription("Handle, 0x address, or keyword").setRequired(true)
          )
          .addStringOption((o) =>
            o.setName("name").setDescription("Optional nickname/label for this entry (e.g. Vitalik)").setRequired(false)
          )
      )
      .addSubcommand((s) =>
        s
          .setName("remove")
          .setDescription("Remove user from watch list")
          .addStringOption((o) =>
            o.setName("type").setDescription("Watch type").setRequired(true).addChoices(
              { name: "X (Twitter)", value: "x" },
              { name: "Farcaster", value: "fc" },
              { name: "Wallet", value: "wallet" },
              { name: "Keyword", value: "keyword" }
            )
          )
          .addStringOption((o) =>
            o.setName("value").setDescription("Handle, address, or keyword to remove").setRequired(true)
          )
      )
      .addSubcommand((s) =>
        s
          .setName("edit")
          .setDescription("Edit the nickname of a watch list entry")
          .addStringOption((o) =>
            o.setName("type").setDescription("Watch type").setRequired(true).addChoices(
              { name: "X (Twitter)", value: "x" },
              { name: "Farcaster", value: "fc" },
              { name: "Wallet", value: "wallet" },
              { name: "Keyword", value: "keyword" }
            )
          )
          .addStringOption((o) =>
            o.setName("value").setDescription("Handle, 0x address, or keyword (must match existing entry)").setRequired(true)
          )
          .addStringOption((o) =>
            o.setName("name").setDescription("New nickname/label (leave empty to clear)").setRequired(false)
          )
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("claim-watch")
      .setDescription("Get notified when a token's fees are claimed")
      .addSubcommand((s) => s.setName("list").setDescription("List tokens on the claim watch list"))
      .addSubcommand((s) =>
        s
          .setName("add")
          .setDescription("Add a token to the claim watch list")
          .addStringOption((o) =>
            o.setName("token_address").setDescription("Token contract address (0x...)").setRequired(true)
          )
          .addStringOption((o) =>
            o.setName("name").setDescription("Optional label for this token (e.g. \"My token\")").setRequired(false)
          )
      )
      .addSubcommand((s) =>
        s
          .setName("remove")
          .setDescription("Remove a token from the claim watch list")
          .addStringOption((o) =>
            o.setName("token_address").setDescription("Token address (0x...) or label to remove").setRequired(true)
          )
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("claims-for-wallet")
      .setDescription("List Bankr tokens a wallet has claimed (fee claims only)")
      .addStringOption((o) =>
        o.setName("wallet").setDescription("Wallet address (0x...)").setRequired(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("claims-for-token")
      .setDescription("List wallets that have claimed this token (historical RPC + optional BaseScan)")
      .addStringOption((o) =>
        o.setName("token").setDescription("Token address (0x...ba3) or Bankr launch URL").setRequired(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("claim-channel")
      .setDescription("Send claim alerts for a specific token to a channel (filter firehose by token)")
      .addSubcommand((s) =>
        s
          .setName("add")
          .setDescription("When this token is claimed, post to the chosen channel")
          .addStringOption((o) =>
            o.setName("token").setDescription("Token contract address (0x...ba3)").setRequired(true)
          )
          .addChannelOption((o) =>
            o.setName("channel").setDescription("Channel to post claim alerts").setRequired(true)
          )
      )
      .addSubcommand((s) =>
        s
          .setName("remove")
          .setDescription("Stop sending claim alerts for this token to a channel")
          .addStringOption((o) =>
            o.setName("token").setDescription("Token address (0x...) or label").setRequired(true)
          )
      )
      .addSubcommand((s) => s.setName("list").setDescription("List token → channel mappings"))
      .toJSON(),
    ...(HIDE_DEPLOY_COMMAND ? [] : [
      new SlashCommandBuilder()
        .setName("deploy")
        .setDescription("Deploy a Bankr token (ticker, description, links; fees to wallet, X, or Farcaster)")
        .addStringOption((o) =>
          o
            .setName("name")
            .setDescription("Token name (required, 1–100 chars)")
            .setRequired(true)
        )
        .addStringOption((o) =>
          o
            .setName("symbol")
            .setDescription("Ticker symbol (optional, 1–10 chars)")
            .setRequired(false)
        )
        .addStringOption((o) =>
          o
            .setName("description")
            .setDescription("Short description (optional, max 500 chars)")
            .setRequired(false)
        )
        .addStringOption((o) =>
          o
            .setName("image_url")
            .setDescription("URL to token logo image")
            .setRequired(false)
        )
        .addStringOption((o) =>
          o
            .setName("website_url")
            .setDescription("Token website URL")
            .setRequired(false)
        )
        .addStringOption((o) =>
          o
            .setName("tweet_url")
            .setDescription("Twitter/X post URL about the token")
            .setRequired(false)
        )
        .addStringOption((o) =>
          o
            .setName("fee_recipient_type")
            .setDescription("Where to send creator fees (57%)")
            .setRequired(false)
            .addChoices(
              { name: "Wallet (0x...)", value: "wallet" },
              { name: "X (Twitter) handle", value: "x" },
              { name: "Farcaster handle", value: "farcaster" },
              { name: "ENS name", value: "ens" }
            )
        )
        .addStringOption((o) =>
          o
            .setName("fee_recipient_value")
            .setDescription("Address, @handle, or ENS (required if fee type is set)")
            .setRequired(false)
        )
        .addBooleanOption((o) =>
          o
            .setName("simulate_only")
            .setDescription("Dry run: no real deploy (default: false)")
            .setRequired(false)
        )
        .toJSON(),
    ]),
    new SlashCommandBuilder()
      .setName("setup")
      .setDescription("Configure Bankr monitor for this server (API key, channels, rules)")
      .addStringOption((o) =>
        o
          .setName("api_key")
          .setDescription("Your Bankr API key (from bankr.bot/api)")
          .setRequired(true)
      )
      .addChannelOption((o) =>
        o
          .setName("all_launches_channel")
          .setDescription("Firehose: every Bankr launch (no filters). Optional if curated channel set.")
          .setRequired(false)
      )
      .addChannelOption((o) =>
        o
          .setName("alert_channel")
          .setDescription("Curated: only launches passing rules (X match, max deploys/day). Optional if firehose set.")
          .setRequired(false)
      )
      .addChannelOption((o) =>
        o
          .setName("watch_channel")
          .setDescription("Channel for watch-list matches only (optional)")
          .setRequired(false)
      )
      .addChannelOption((o) =>
        o
          .setName("claim_channel")
          .setDescription("Channel for fee-claim alerts only (optional; else uses watch/alert channel)")
          .setRequired(false)
      )
      .addChannelOption((o) =>
        o
          .setName("hot_channel")
          .setDescription("Channel for hot token alerts (5+ buys in 1 min, 20+ holders). Optional.")
          .setRequired(false)
      )
      .addBooleanOption((o) =>
        o
          .setName("hot_enabled")
          .setDescription("Enable hot token alerts (default: true)")
          .setRequired(false)
      )
      .addStringOption((o) =>
        o
          .setName("hot_ping_role_ids")
          .setDescription("Roles to ping: type @ and select roles, or paste role IDs (e.g. 123,456). No @everyone.")
          .setRequired(false)
      )
      .addBooleanOption((o) =>
        o.setName("ping_on_hot").setDescription("Ping roles when hot token alert posts (default: true)").setRequired(false)
      )
      .addBooleanOption((o) =>
        o.setName("ping_on_trending").setDescription("Ping roles when trending alert posts (default: true)").setRequired(false)
      )
      .addBooleanOption((o) =>
        o.setName("ping_on_watch_match").setDescription("Ping roles when a launch matches watch list (default: false)").setRequired(false)
      )
      .addBooleanOption((o) =>
        o.setName("ping_on_curated").setDescription("Ping roles when curated deployment posts (default: false)").setRequired(false)
      )
      .addChannelOption((o) =>
        o
          .setName("trending_channel")
          .setDescription("Channel for trending token alerts. Optional.")
          .setRequired(false)
      )
      .addBooleanOption((o) =>
        o
          .setName("trending_enabled")
          .setDescription("Enable trending alerts (default: false)")
          .setRequired(false)
      )
      .addBooleanOption((o) =>
        o
          .setName("filter_x_match")
          .setDescription("Only alert when deployer and fee recipient share same X/FC (default: false)")
          .setRequired(false)
      )
      .addBooleanOption((o) =>
        o
          .setName("filter_fee_recipient_has_x")
          .setDescription("Curated: only show deployments where fee recipient has an X account (default: false)")
          .setRequired(false)
      )
      .addIntegerOption((o) =>
        o
          .setName("filter_max_deploys")
          .setDescription("Max deploys per day to alert (optional, 0 = no limit)")
          .setRequired(false)
      )
      .addNumberOption((o) =>
        o
          .setName("poll_interval_min")
          .setDescription("Minutes between checks (default: 1)")
          .setRequired(false)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("settings")
      .setDescription("View or edit this server's Bankr monitor config")
      .addSubcommand((s) =>
        s
          .setName("rules")
          .setDescription("Update monitoring rules")
          .addBooleanOption((o) =>
            o.setName("filter_x_match").setDescription("Only alert when deployer and fee recipient match").setRequired(false)
          )
          .addBooleanOption((o) =>
            o.setName("filter_fee_recipient_has_x").setDescription("Curated: only show when fee recipient has X account").setRequired(false)
          )
          .addIntegerOption((o) =>
            o.setName("filter_max_deploys").setDescription("Max deploys per day to alert").setRequired(false)
          )
          .addNumberOption((o) =>
            o.setName("poll_interval_min").setDescription("Minutes between checks").setRequired(false)
          )
      )
      .addSubcommand((s) =>
        s
          .setName("channels")
          .setDescription("Update alert channels")
          .addChannelOption((o) =>
            o.setName("all_launches_channel").setDescription("Firehose: every Bankr launch (clear = unset)").setRequired(false)
          )
          .addChannelOption((o) =>
            o.setName("alert_channel").setDescription("Curated: rules apply (clear = unset)").setRequired(false)
          )
          .addChannelOption((o) =>
            o.setName("watch_channel").setDescription("Channel for watch-list matches").setRequired(false)
          )
          .addChannelOption((o) =>
            o.setName("claim_channel").setDescription("Channel for fee-claim alerts (else watch/alert)").setRequired(false)
          )
          .addChannelOption((o) =>
            o.setName("hot_channel").setDescription("Channel for hot token alerts").setRequired(false)
          )
          .addBooleanOption((o) =>
            o.setName("hot_enabled").setDescription("Enable hot token alerts").setRequired(false)
          )
          .addStringOption((o) =>
            o.setName("hot_ping_role_ids").setDescription("Roles to ping: @mention roles or paste role IDs (no @everyone)").setRequired(false)
          )
          .addChannelOption((o) =>
            o.setName("trending_channel").setDescription("Channel for trending alerts").setRequired(false)
          )
          .addBooleanOption((o) =>
            o.setName("trending_enabled").setDescription("Enable trending alerts").setRequired(false)
          )
      )
      .addSubcommand((s) =>
        s
          .setName("pings")
          .setDescription("When to ping roles (hot, trending, watch list, curated)")
          .addBooleanOption((o) => o.setName("ping_on_hot").setDescription("Ping when hot token alert posts").setRequired(false))
          .addBooleanOption((o) => o.setName("ping_on_trending").setDescription("Ping when trending alert posts").setRequired(false))
          .addBooleanOption((o) => o.setName("ping_on_watch_match").setDescription("Ping when launch matches watch list").setRequired(false))
          .addBooleanOption((o) => o.setName("ping_on_curated").setDescription("Ping when curated deployment posts").setRequired(false))
      )
      .addSubcommand((s) =>
        s
          .setName("telegram")
          .setDescription("Telegram group + topic IDs: All launches, Hot launches, Trending Tokens, X only fee recipient")
          .addStringOption((o) =>
            o.setName("group_chat_id").setDescription("Telegram group chat ID (e.g. -1001234567890)").setRequired(false)
          )
          .addStringOption((o) =>
            o.setName("topic_firehose").setDescription("Topic ID for All launches (every launch)").setRequired(false)
          )
          .addStringOption((o) =>
            o.setName("topic_curated").setDescription("Topic ID for X only fee recipient tokens").setRequired(false)
          )
          .addStringOption((o) =>
            o.setName("topic_hot").setDescription("Topic ID for Hot launches").setRequired(false)
          )
          .addStringOption((o) =>
            o.setName("topic_trending").setDescription("Topic ID for Trending Tokens").setRequired(false)
          )
          .addIntegerOption((o) =>
            o.setName("delay_hot_trending_sec").setDescription("Delay (seconds) before Hot/Trending pings to Telegram after Discord (default 60; 0 = same time)").setRequired(false)
          )
      )
      .addSubcommand((s) =>
        s
          .setName("api_key")
          .setDescription("Update your Bankr API key")
          .addStringOption((o) =>
            o.setName("key").setDescription("New Bankr API key").setRequired(true)
          )
      )
      .addSubcommand((s) => s.setName("show").setDescription("Show current config (channels, rules; API key hidden)"))
      .toJSON(),
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("Show how to use BankrMonitor (watch, lookup, wallet lookup)" + (HIDE_DEPLOY_COMMAND ? "" : ", deploy"))
      .toJSON(),
  ];

  try {
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log("Slash commands registered");
  } catch (e) {
    console.error("Failed to register commands:", e.message);
  }
}

/** Per-tenant filter: same logic as notify.js passesFilters but using tenant rules. */
function tenantPassesFilters(launch, rules) {
  const filterXMatch = rules?.filterXMatch === true;
  const filterFeeRecipientHasX = rules?.filterFeeRecipientHasX === true;
  const filterMaxDeploys = rules?.filterMaxDeploys != null ? Number(rules.filterMaxDeploys) : null;
  if (filterXMatch) {
    const normX = (u) => (u && typeof u === "string" ? u.replace(/^@/, "").trim().toLowerCase() : null);
    const normFc = (u) => (u && typeof u === "string" ? String(u).trim().toLowerCase() : null);
    const deployerX = launch.launcherX ? normX(String(launch.launcherX)) : null;
    const feeX = launch.beneficiaries?.[0]?.xUsername ? normX(String(launch.beneficiaries[0].xUsername)) : null;
    const deployerFc = launch.launcherFarcaster ? normFc(String(launch.launcherFarcaster)) : null;
    const feeFc = launch.beneficiaries?.[0]?.farcaster ? normFc(String(launch.beneficiaries[0].farcaster)) : null;
    const xMatch = deployerX && feeX && deployerX === feeX;
    const fcMatch = deployerFc && feeFc && deployerFc === feeFc;
    if (!xMatch && !fcMatch) return false;
  }
  if (filterFeeRecipientHasX) {
    const feeX = launch.beneficiaries?.[0]?.xUsername ? String(launch.beneficiaries[0].xUsername).trim().replace(/^@/, "") : null;
    if (!feeX) return false;
  }
  if (filterMaxDeploys != null && filterMaxDeploys > 0 && launch.deployCount != null && launch.deployCount > filterMaxDeploys) return false;
  return true;
}

/** Per-tenant watch match: same logic as notify.js isWatchMatch but using tenant watch list. */
function isWatchMatchForTenant(launch, watchList) {
  const normX = (u) => (u && typeof u === "string" ? u.replace(/^@/, "").trim().toLowerCase() : null);
  const normFc = (u) => (u && typeof u === "string" ? String(u).trim().toLowerCase() : null);
  const deployerX = launch.launcherX ? normX(String(launch.launcherX)) : null;
  const deployerFc = launch.launcherFarcaster ? normFc(String(launch.launcherFarcaster)) : null;
  const normAddr = (a) => (a && /^0x[a-fA-F0-9]{40}$/.test(String(a).trim()) ? String(a).trim().toLowerCase() : null);
  const launcherAddr = normAddr(launch.launcher);
  const feeAddrs = (launch.beneficiaries || [])
    .map((b) => (typeof b === "object" ? (b.beneficiary ?? b.address ?? b.wallet) : b))
    .map(normAddr)
    .filter(Boolean);
  const allWalletAddrs = [launcherAddr, ...feeAddrs].filter(Boolean);
  const searchText = `${launch.name || ""} ${launch.symbol || ""}`.toLowerCase();
  const watchX = watchList?.x ?? new Set();
  const watchFc = watchList?.fc ?? new Set();
  const watchWallet = watchList?.wallet ?? new Set();
  const watchKeywords = watchList?.keywords ?? new Set();
  const inWatchX = deployerX && watchX.has(deployerX);
  const inWatchFc = deployerFc && watchFc.has(deployerFc);
  const inWatchWallet = watchWallet.size > 0 && allWalletAddrs.some((a) => watchWallet.has(a));
  const inWatchKeyword = watchKeywords.size > 0 && [...watchKeywords].some((kw) => searchText.includes(String(kw).toLowerCase().trim()));
  return !!(inWatchX || inWatchFc || inWatchWallet || inWatchKeyword);
}

/** Parse role IDs from string: comma/space-separated numeric IDs and/or Discord role mentions <@&id>. */
function parseRoleIdsFromInput(raw) {
  if (raw == null || String(raw).trim() === "") return [];
  const seen = new Set();
  const ids = [];
  const str = String(raw).trim();
  // Collect all <@&id> mentions (Discord may insert these when you @role)
  for (const m of str.matchAll(/<@&(\d+)>/g)) ids.push(m[1]);
  // Also collect comma/space-separated bare numeric IDs
  for (const s of str.split(/[\s,]+/)) {
    const t = s.trim();
    if (t && /^\d+$/.test(t) && !t.startsWith("<")) ids.push(t);
  }
  return ids.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Build role mention string for ping (hot/trending/watch/curated). Uses tenant config or env. */
function buildRolePingContent(roleIds, suffix = "🔥 **Hot token**") {
  const ids = Array.isArray(roleIds) ? roleIds.filter((id) => /^\d+$/.test(String(id))) : [];
  if (ids.length > 0) return ids.map((id) => `<@&${id}>`).join(" ") + " " + suffix;
  const parts = [];
  if (HOT_LAUNCH_USE_EVERYONE) parts.push("@everyone");
  if (HOT_LAUNCH_DISCORD_ROLE_IDS.length > 0) parts.push(HOT_LAUNCH_DISCORD_ROLE_IDS.map((id) => `<@&${id}>`).join(" "));
  parts.push(suffix);
  return parts.join(" ");
}

/** Schedule a delayed check for "hot" (buys/holders) and "trending" (higher buy threshold). Sends only to hot/trending channels, not firehose. */
function scheduleHotLaunchCheck(launch, { discordHotChannelIds = [], discordTrendingChannelIds = [], telegramChatIds, telegramHotTargets = [], telegramTrendingTargets = [], bankrApiKey, hotPingConfigByGuildId = {}, telegramHotPingDelayMs: overrideDelayMs } = {}) {
  const hasHotDest = discordHotChannelIds.length > 0 || (telegramHotTargets?.length > 0);
  const hasTrendingDest = discordTrendingChannelIds.length > 0 || (telegramTrendingTargets?.length > 0);
  const hasTelegram = (telegramChatIds?.length > 0) || hasHotDest || hasTrendingDest;
  const telegramDelayMs = overrideDelayMs != null ? Math.max(0, Number(overrideDelayMs)) : TELEGRAM_HOT_PING_DELAY_MS;
  if (
    (HOT_LAUNCH_MIN_BUYS_FIRST_MIN <= 0 && HOT_LAUNCH_MIN_HOLDERS <= 0 && TRENDING_MIN_BUYS_5M <= 0 && TRENDING_MIN_BUYS_1H <= 0) ||
    (!hasHotDest && !hasTrendingDest && !hasTelegram)
  ) {
    return;
  }
  const apiKey = bankrApiKey ?? process.env.BANKR_API_KEY;
  const hasPerGuildConfig = typeof hotPingConfigByGuildId === "object" && Object.keys(hotPingConfigByGuildId).length > 0;
  setTimeout(async () => {
    try {
      const stats = await getHotTokenStats(launch.tokenAddress);
      if (!stats) return;
      const buys5m = stats.buys5m ?? 0;
      const buys1h = stats.buys1h ?? 0;
      const hotByBuys = HOT_LAUNCH_MIN_BUYS_FIRST_MIN > 0 && buys5m >= HOT_LAUNCH_MIN_BUYS_FIRST_MIN;
      const hotByHolders =
        HOT_LAUNCH_MIN_HOLDERS > 0 && stats.holderCount != null && stats.holderCount >= HOT_LAUNCH_MIN_HOLDERS;
      const isHot = hotByBuys || hotByHolders;
      const isTrending =
        (TRENDING_MIN_BUYS_5M > 0 && buys5m >= TRENDING_MIN_BUYS_5M) ||
        (TRENDING_MIN_BUYS_1H > 0 && buys1h >= TRENDING_MIN_BUYS_1H);
      if (!isHot && !isTrending) return;
      const hotStats = {
        hotByBuys,
        hotByHolders,
        buysFirstMin: buys5m,
        holderCount: stats.holderCount,
        isTrending,
        buys5m,
        buys1h,
      };
      const launchForEmbed =
        (await fetchLaunchByTokenAddress(launch.tokenAddress, apiKey)) || launch;
      const embedHot = buildLaunchEmbed(launchForEmbed);
      const embedTrending = buildLaunchEmbed(launchForEmbed);
      embedHot.color = 0xff6600;
      embedTrending.color = 0x5865f2;
      if (hotByBuys && hotByHolders) {
        embedHot.title = `🔥👥 Hot: ${launchForEmbed.name} ($${launchForEmbed.symbol}) — ${buys5m}+ buys in first min · 20+ holders`;
      } else if (hotByBuys) {
        embedHot.title = `🔥 Hot: ${launchForEmbed.name} ($${launchForEmbed.symbol}) — ${buys5m}+ buys in first minute`;
      } else {
        embedHot.title = `👥 Hot: ${launchForEmbed.name} ($${launchForEmbed.symbol}) — 20+ holders`;
      }
      embedTrending.title = `📈 Trending: ${launchForEmbed.name} ($${launchForEmbed.symbol}) — ${buys5m} buys (5m) · ${buys1h} (1h)`;
      const hotSuffix = "🔥 **Hot token**";
      const trendingSuffix = "📈 **Trending**";
      function getPingContent(guildId, channelId, forTrending) {
        const config = hasPerGuildConfig && guildId ? hotPingConfigByGuildId[guildId] : null;
        const roleIds = config?.roleIds ?? [];
        const hasRoles = roleIds.length > 0;
        if (config && hasRoles) {
          if (!forTrending && channelId === config.hotAlertChannelId && config.pingOnHot) return buildRolePingContent(roleIds, hotSuffix);
          if (forTrending && channelId === config.trendingAlertChannelId && config.pingOnTrending) return buildRolePingContent(roleIds, trendingSuffix);
        }
        return null;
      }
      const posted = new Set();
      if (isHot) {
        for (const channelId of discordHotChannelIds) {
          if (posted.has(channelId)) continue;
          posted.add(channelId);
          const ch = await client.channels.fetch(channelId).catch(() => null);
          if (ch) {
            const pingContent = getPingContent(ch.guildId, channelId, false);
            await ch.send({ content: pingContent, embeds: [embedHot] }).catch((e) => console.error("Hot ping Discord:", e.message));
          }
        }
      }
      if (isTrending) {
        for (const channelId of discordTrendingChannelIds) {
          if (posted.has(channelId)) continue;
          posted.add(channelId);
          const ch = await client.channels.fetch(channelId).catch(() => null);
          if (ch) {
            const pingContent = getPingContent(ch.guildId, channelId, true);
            await ch.send({ content: pingContent, embeds: [embedTrending] }).catch((e) => console.error("Trending ping Discord:", e.message));
          }
        }
      }
      const seenTg = new Set();
      for (const chatId of telegramChatIds || []) {
        const key = `${chatId}`;
        if (seenTg.has(key)) continue;
        seenTg.add(key);
        if (isHot) await sendTelegramHotPing(launchForEmbed, hotStats, { chatId }).catch(() => {});
      }
      const sendTgHot = isHot && (telegramHotTargets?.length > 0);
      const sendTgTrending = isTrending && (telegramTrendingTargets?.length > 0);
      const tgTopicTargets = sendTgHot || sendTgTrending;
      if (tgTopicTargets && telegramDelayMs > 0) {
        setTimeout(async () => {
          try {
            const seen = new Set();
            if (sendTgHot) {
              for (const t of telegramHotTargets || []) {
                const key = `${t.chatId}:${t.messageThreadId ?? ""}`;
                if (seen.has(key)) continue;
                seen.add(key);
                await sendTelegramHotPing(launchForEmbed, hotStats, { chatId: t.chatId, messageThreadId: t.messageThreadId }).catch(() => {});
              }
            }
            if (sendTgTrending) {
              for (const t of telegramTrendingTargets || []) {
                const key = `${t.chatId}:${t.messageThreadId ?? ""}`;
                if (seen.has(key)) continue;
                seen.add(key);
                await sendTelegramHotPing(launchForEmbed, hotStats, { chatId: t.chatId, messageThreadId: t.messageThreadId, trending: true }).catch(() => {});
              }
            }
          } catch (e) {
            console.error("Telegram hot/trending delayed ping failed:", e.message);
          }
        }, telegramDelayMs);
      } else if (tgTopicTargets) {
        if (sendTgHot) {
          for (const t of telegramHotTargets || []) {
            const key = `${t.chatId}:${t.messageThreadId ?? ""}`;
            if (seenTg.has(key)) continue;
            seenTg.add(key);
            await sendTelegramHotPing(launchForEmbed, hotStats, { chatId: t.chatId, messageThreadId: t.messageThreadId }).catch(() => {});
          }
        }
        if (sendTgTrending) {
          for (const t of telegramTrendingTargets || []) {
            const key = `${t.chatId}:${t.messageThreadId ?? ""}`;
            if (seenTg.has(key)) continue;
            seenTg.add(key);
            await sendTelegramHotPing(launchForEmbed, hotStats, { chatId: t.chatId, messageThreadId: t.messageThreadId, trending: true }).catch(() => {});
          }
        }
      }
    } catch (e) {
      console.error("Hot launch check failed:", e.message);
      debugLogError(e, "scheduleHotLaunchCheck");
    }
  }, HOT_LAUNCH_DELAY_MS);
}

async function runNotify() {
  const hasEnvChannels = ALL_LAUNCHES_CHANNEL_ID || ALERT_CHANNEL_ID || WATCH_ALERT_CHANNEL_ID;
  if (hasEnvChannels) {
    try {
      const { newLaunches } = await runNotifyCycle();
      const allChannel = ALL_LAUNCHES_CHANNEL_ID ? await client.channels.fetch(ALL_LAUNCHES_CHANNEL_ID).catch(() => null) : null;
      const alertChannel = ALERT_CHANNEL_ID ? await client.channels.fetch(ALERT_CHANNEL_ID).catch(() => null) : null;
      const watchChannel = WATCH_ALERT_CHANNEL_ID ? await client.channels.fetch(WATCH_ALERT_CHANNEL_ID).catch(() => null) : null;
      const curatedLaunches = newLaunches.filter((l) => l.passedFilters !== false);

      for (const launch of newLaunches) {
        const embed = buildLaunchEmbed(launch);
        const showInAll = true;
        const showInCurated = launch.passedFilters !== false;
        const showInWatch = launch.isWatchMatch;
        if (showInCurated && curatedLaunches.length > 0) {
          const idx = curatedLaunches.indexOf(launch) + 1;
          embed.footer = { text: `New deployment · ${idx} of ${curatedLaunches.length}` };
        }
        const posted = new Set();
        async function postOnce(ch) {
          if (!ch || posted.has(ch.id)) return;
          posted.add(ch.id);
          try {
            await ch.send({ embeds: [embed] });
          } catch (e) {
            console.error(`Channel ${ch.id} send failed:`, e.message);
          }
        }
        if (allChannel && showInAll) await postOnce(allChannel);
        if (alertChannel && showInCurated) await postOnce(alertChannel);
        if (watchChannel && showInWatch) await postOnce(watchChannel);
        const envFirehoseTopic = process.env.TELEGRAM_TOPIC_FIREHOSE;
        const envCuratedTopic = process.env.TELEGRAM_TOPIC_CURATED;
        await sendTelegram(launch, envFirehoseTopic != null ? { messageThreadId: envFirehoseTopic } : {}).catch(() => {});
        const sendToEnvCurated =
          envCuratedTopic != null &&
          (TELEGRAM_CURATED_FEE_RECIPIENT_HAS_X ? feeRecipientHasX(launch) : launch.passedFilters !== false);
        if (sendToEnvCurated) {
          await sendTelegram(launch, { messageThreadId: envCuratedTopic }).catch(() => {});
        }
      }
      if (
        HOT_LAUNCH_ENABLED &&
        newLaunches.length > 0 &&
        (HOT_LAUNCH_MIN_BUYS_FIRST_MIN > 0 || HOT_LAUNCH_MIN_HOLDERS > 0 || TRENDING_MIN_BUYS_5M > 0 || TRENDING_MIN_BUYS_1H > 0)
      ) {
        const discordHotIds = HOT_LAUNCH_ALERT_CHANNEL_ID ? [HOT_LAUNCH_ALERT_CHANNEL_ID] : [];
        const discordTrendingIds = TRENDING_ENABLED && TRENDING_ALERT_CHANNEL_ID ? [TRENDING_ALERT_CHANNEL_ID] : [];
        const envChat = process.env.TELEGRAM_CHAT_ID;
        const envHot = process.env.TELEGRAM_TOPIC_HOT;
        const envTrend = process.env.TELEGRAM_TOPIC_TRENDING;
        const telegramIds = envChat && envHot == null && envTrend == null ? [envChat] : [];
        const telegramHotTargets = envChat && envHot != null ? [{ chatId: envChat, messageThreadId: envHot }] : [];
        const telegramTrendingTargets = envChat && envTrend != null ? [{ chatId: envChat, messageThreadId: envTrend }] : [];
        for (const launch of newLaunches) {
          scheduleHotLaunchCheck(launch, {
            discordHotChannelIds: discordHotIds,
            discordTrendingChannelIds: discordTrendingIds,
            telegramChatIds: telegramIds,
            telegramHotTargets,
            telegramTrendingTargets,
            bankrApiKey: process.env.BANKR_API_KEY,
          });
        }
      }
    } catch (e) {
      console.error("Notify failed:", e.message);
    }
  } else {
    const guildIds = await listActiveTenantGuildIds();
    const tenantsWithChannels = [];
    for (const gid of guildIds) {
      const t = await getTenant(gid);
      if (t && (t.allLaunchesChannelId || t.alertChannelId || t.watchAlertChannelId)) tenantsWithChannels.push({ guildId: gid, ...t });
    }
    if (tenantsWithChannels.length > 0) {
      try {
        const firstApiKey = tenantsWithChannels[0]?.bankrApiKey ?? process.env.BANKR_API_KEY;
        const { newLaunches } = await runNotifyCycle({ bankrApiKey: firstApiKey });
        // Per-tenant curated list for "1 of N" footer
        for (const tenant of tenantsWithChannels) {
          tenant._curatedLaunches = newLaunches.filter((l) => tenantPassesFilters(l, tenant.rules));
        }
        for (const launch of newLaunches) {
          const embed = buildLaunchEmbed(launch);
          for (const tenant of tenantsWithChannels) {
            const showInCurated = tenantPassesFilters(launch, tenant.rules);
            const curatedForTenant = tenant._curatedLaunches || [];
            const curatedEmbed =
              showInCurated && curatedForTenant.length > 0
                ? { ...embed, footer: { text: `New deployment · ${curatedForTenant.indexOf(launch) + 1} of ${curatedForTenant.length}` } }
                : embed;
            const watchList = await getWatchListForGuild(tenant.guildId);
            const showInWatch = isWatchMatchForTenant(launch, watchList);
            const allCh = tenant.allLaunchesChannelId ? await client.channels.fetch(tenant.allLaunchesChannelId).catch(() => null) : null;
            const alertCh = tenant.alertChannelId ? await client.channels.fetch(tenant.alertChannelId).catch(() => null) : null;
            const watchCh = tenant.watchAlertChannelId ? await client.channels.fetch(tenant.watchAlertChannelId).catch(() => null) : null;
            const roleIds = (tenant.hotLaunchRoleIds || []).filter((id) => /^\d+$/.test(String(id)));
            const pingCurated = showInCurated && tenant.pingOnCurated && roleIds.length > 0;
            const pingWatch = showInWatch && tenant.pingOnWatchMatch && roleIds.length > 0;
            const curatedContent = pingCurated ? buildRolePingContent(roleIds, "📋 **New curated deployment**") : null;
            const watchContent = pingWatch ? buildRolePingContent(roleIds, "👀 **Watch list match**") : null;
            const posted = new Set();
            async function postOnce(ch, emb = embed, content = null) {
              if (!ch || posted.has(ch.id)) return;
              posted.add(ch.id);
              await ch.send({ content: content || undefined, embeds: [emb] }).catch(() => {});
            }
            if (allCh) await postOnce(allCh);
            if (alertCh && showInCurated) await postOnce(alertCh, curatedEmbed, curatedContent);
            if (watchCh && showInWatch) await postOnce(watchCh, embed, watchContent);
            if (tenant.telegramChatId) {
              const tgChat = tenant.telegramChatId;
              const topicFirehose = tenant.telegramTopicFirehose ?? undefined;
              const topicCurated = tenant.telegramTopicCurated ?? undefined;
              await sendTelegram(launch, { chatId: tgChat, messageThreadId: topicFirehose }).catch(() => {});
              if (showInCurated && topicCurated != null) {
                await sendTelegram(launch, { chatId: tgChat, messageThreadId: topicCurated }).catch(() => {});
              }
            }
          }
          if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
            const envTopicFirehose = process.env.TELEGRAM_TOPIC_FIREHOSE != null ? process.env.TELEGRAM_TOPIC_FIREHOSE : undefined;
            const envCuratedTopic = process.env.TELEGRAM_TOPIC_CURATED;
            await sendTelegram(launch, { messageThreadId: envTopicFirehose }).catch(() => {});
            const sendToEnvCurated =
              envCuratedTopic != null &&
              (TELEGRAM_CURATED_FEE_RECIPIENT_HAS_X ? feeRecipientHasX(launch) : tenantPassesFilters(launch, {}));
            if (sendToEnvCurated) {
              await sendTelegram(launch, { messageThreadId: envCuratedTopic }).catch(() => {});
            }
          }
        }
        const anyHotEnabled = tenantsWithChannels.some((t) => t.hotLaunchEnabled !== false);
        if (
          anyHotEnabled &&
          newLaunches.length > 0 &&
          (HOT_LAUNCH_MIN_BUYS_FIRST_MIN > 0 || HOT_LAUNCH_MIN_HOLDERS > 0 || TRENDING_MIN_BUYS_5M > 0 || TRENDING_MIN_BUYS_1H > 0)
        ) {
          const discordHotChannelIds = [];
          const discordTrendingChannelIds = [];
          const telegramIds = new Set();
          const telegramHotTargets = [];
          const telegramTrendingTargets = [];
          const hotPingConfigByGuildId = {};
          let telegramDelayOverride = null;
          if (process.env.TELEGRAM_CHAT_ID) {
            const envHot = process.env.TELEGRAM_TOPIC_HOT != null ? process.env.TELEGRAM_TOPIC_HOT : undefined;
            const envTrend = process.env.TELEGRAM_TOPIC_TRENDING != null ? process.env.TELEGRAM_TOPIC_TRENDING : undefined;
            if (envHot != null) telegramHotTargets.push({ chatId: process.env.TELEGRAM_CHAT_ID, messageThreadId: envHot });
            else if (envTrend == null) telegramIds.add(process.env.TELEGRAM_CHAT_ID);
            if (envTrend != null) telegramTrendingTargets.push({ chatId: process.env.TELEGRAM_CHAT_ID, messageThreadId: envTrend });
          }
          for (const tenant of tenantsWithChannels) {
            if (tenant.hotLaunchEnabled === false) continue;
            if (tenant.hotAlertChannelId) discordHotChannelIds.push(tenant.hotAlertChannelId);
            if (tenant.trendingEnabled && tenant.trendingAlertChannelId) discordTrendingChannelIds.push(tenant.trendingAlertChannelId);
            if (tenant.telegramChatId) {
              const th = tenant.telegramTopicHot ?? null;
              const tr = tenant.telegramTopicTrending ?? null;
              if (th != null) telegramHotTargets.push({ chatId: tenant.telegramChatId, messageThreadId: th });
              else if (tr == null) telegramIds.add(tenant.telegramChatId);
              if (tr != null) telegramTrendingTargets.push({ chatId: tenant.telegramChatId, messageThreadId: tr });
              if ((th != null || tr != null) && tenant.telegramHotPingDelayMs != null) telegramDelayOverride = tenant.telegramHotPingDelayMs;
            }
            if (tenant.guildId) {
              hotPingConfigByGuildId[tenant.guildId] = {
                roleIds: (tenant.hotLaunchRoleIds || []).filter((id) => /^\d+$/.test(String(id))),
                pingOnHot: tenant.pingOnHot !== false,
                pingOnTrending: tenant.pingOnTrending !== false,
                hotAlertChannelId: tenant.hotAlertChannelId ?? null,
                trendingAlertChannelId: tenant.trendingEnabled ? (tenant.trendingAlertChannelId ?? null) : null,
              };
            }
          }
          for (const launch of newLaunches) {
            scheduleHotLaunchCheck(launch, {
              discordHotChannelIds: [...new Set(discordHotChannelIds)],
              discordTrendingChannelIds: [...new Set(discordTrendingChannelIds)],
              telegramChatIds: [...telegramIds],
              telegramHotTargets,
              telegramTrendingTargets,
              bankrApiKey: firstApiKey,
              hotPingConfigByGuildId,
              telegramHotPingDelayMs: telegramDelayOverride,
            });
          }
        }
      } catch (e) {
        console.error("Notify failed:", e.message);
        debugLogError(e, "runNotify (tenant channels)");
      }
    } else {
      const child = spawn(
        process.execPath,
        [join(__dirname, "notify.js")],
        { stdio: "inherit", env: process.env }
      );
      await new Promise((resolve, reject) => {
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      });
    }
  }
  await runClaimWatchCycle().catch((e) => {
    console.error("Claim watch cycle failed:", e.message);
    debugLogError(e, "runClaimWatchCycle");
  });
}

const CLAIM_WATCH_DECIMALS = 18;
const CLAIM_DROP_TOLERANCE = 1e-12;

async function runClaimWatchCycle() {
  const guildIds = await listActiveTenantGuildIds();
  for (const guildId of guildIds) {
    const tenant = await getTenant(guildId);
    const tokens = await getClaimWatchTokens(guildId);
    if (tokens.length === 0) continue;
    const channelId = tenant?.claimAlertChannelId || tenant?.watchAlertChannelId || tenant?.alertChannelId;
    if (!channelId) continue;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) continue;

    for (const tokenAddress of tokens) {
      try {
        const out = await getTokenFees(tokenAddress, { bankrApiKey: tenant?.bankrApiKey ?? process.env.BANKR_API_KEY });
        const hookFees = out.hookFees;
        const currentWeth = hookFees ? Number(hookFees.beneficiaryFees0) / 10 ** CLAIM_WATCH_DECIMALS : 0;
        const currentToken = hookFees ? Number(hookFees.beneficiaryFees1) / 10 ** CLAIM_WATCH_DECIMALS : 0;
        const symbol = out.symbol ?? "—";
        const name = out.name ?? "—";

        const prev = await getClaimState(guildId, tokenAddress);
        if (!prev) {
          await setClaimState(guildId, tokenAddress, { lastClaimableToken: currentToken, lastClaimableWeth: currentWeth, symbol });
          continue;
        }

        const tokenDropped = currentToken < prev.lastClaimableToken - CLAIM_DROP_TOLERANCE;
        const wethDropped = currentWeth < prev.lastClaimableWeth - CLAIM_DROP_TOLERANCE;
        if (tokenDropped || wethDropped) {
          const claimFromIndexer = await fetchLatestFeeClaim(tokenAddress, out.feeWallet ?? undefined);
          let claimedWeth = 0;
          let claimedToken = 0;
          let txHash = null;
          if (claimFromIndexer && (claimFromIndexer.weth > 0 || claimFromIndexer.tokenAmount > 0)) {
            claimedWeth = claimFromIndexer.weth;
            claimedToken = claimFromIndexer.tokenAmount;
            txHash = claimFromIndexer.transactionHash;
          } else {
            claimedWeth = Math.max(0, prev.lastClaimableWeth - currentWeth);
            claimedToken = Math.max(0, prev.lastClaimableToken - currentToken);
          }
          const parts = [];
          if (claimedWeth > 0) parts.push(`**Claimed:** ${claimedWeth.toFixed(4)} WETH`);
          if (claimedToken > 0) {
            const fmt =
              claimedToken >= 1e9
                ? `${(claimedToken / 1e9).toFixed(0)}B`
                : claimedToken >= 1e6
                  ? `${(claimedToken / 1e6).toFixed(0)}M`
                  : claimedToken >= 1e3
                    ? `${(claimedToken / 1e3).toFixed(1)}K`
                    : claimedToken.toFixed(4);
            parts.push(`${fmt} ${symbol}`);
          }
          const descLines = [
            `**Token:** ${name} ($${symbol})`,
            `**CA:** \`${tokenAddress}\``,
            parts.length ? parts.join(" · ") : "Fees claimed.",
            "",
            "[View on Bankr](https://bankr.bot/launches/" + tokenAddress + ")",
          ];
          if (txHash) {
            descLines.push("");
            descLines.push(`**Tx:** https://basescan.org/tx/${txHash}`);
          }
          const embed = {
            color: 0x00_80_00,
            title: "💰 Fee claim detected",
            description: descLines.join("\n"),
          };
          await channel.send({ embeds: [embed] }).catch((e) => console.error("Claim alert send failed:", e.message));
        }

        await setClaimState(guildId, tokenAddress, { lastClaimableToken: currentToken, lastClaimableWeth: currentWeth, symbol });
      } catch (e) {
        console.error(`Claim watch ${tokenAddress} failed:`, e.message);
      }
    }
  }
}

/** True when current time is in the claim quiet window (e.g. 8–9pm EST) to avoid pings and Alchemy load. */
function isInClaimQuietWindow() {
  const start = parseInt(process.env.CLAIM_QUIET_START_EST ?? "", 10);
  const end = parseInt(process.env.CLAIM_QUIET_END_EST ?? "", 10);
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false });
  const hour = parseInt(formatter.format(now), 10);
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/** Telegram long-poll for /claims <wallet> and /topicid. Runs in background when TELEGRAM_BOT_TOKEN is set. */
function startTelegramClaimsPolling(token, allowedChatIds) {
  let offset = 0;
  const claimsRegex = /^\/claims\s+(0x[a-fA-F0-9]{40})$/;
  const topicIdRegex = /^\/(topicid|id)$/i;
  async function sendTg(chatId, text, opts = {}) {
    const body = { chat_id: chatId, text, ...opts };
    if (opts.message_thread_id != null) body.message_thread_id = opts.message_thread_id;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  }
  async function poll() {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=25`
      );
      const data = await res.json();
      const updates = data?.result ?? [];
      for (const u of updates) {
        offset = Math.max(offset, (u.update_id ?? 0) + 1);
        const text = u?.message?.text?.trim();
        const chatId = u?.message?.chat?.id;
        const threadId = u?.message?.message_thread_id;
        if (!text || chatId == null) continue;
        // /topicid or /id — always reply (ignore allowedChatIds) so you can discover chat + topic IDs
        if (topicIdRegex.test(text)) {
          const threadPart = threadId != null
            ? `Topic ID: \`${threadId}\`\n\nFor claim alerts in this topic set:\nTELEGRAM_CLAIM_TOPIC_ID=${threadId}`
            : "Topic ID: (General — no topic)\n\nGo into the topic you want and send /topicid there to get its ID.";
          const msg = `Chat ID: \`${chatId}\`\n${threadPart}`;
          await sendTg(chatId, msg, { message_thread_id: threadId ?? undefined, parse_mode: "Markdown" });
          continue;
        }
        if (allowedChatIds?.length && !allowedChatIds.includes(String(chatId))) continue;
        const m = text.match(claimsRegex);
        if (!m) continue;
        const wallet = m[1].toLowerCase();
        try {
          const claims = await getWalletClaims(wallet);
          let reply;
          if (claims.length === 0) {
            reply = `No Bankr fee claims for \`${wallet}\`.`;
          } else {
            const lines = claims.map((c) => {
              const sym = c.poolSymbol ? `$${c.poolSymbol}` : "";
              const bankr = `https://bankr.bot/launches/${c.tokenAddress}`;
              const tx = `https://basescan.org/tx/${c.txHash}`;
              return `${sym ? sym + " " : ""}\`${c.tokenAddress}\` · ${c.wethAmount} WETH · [Bankr](${bankr}) · [TX](${tx})`;
            });
            reply = `*Bankr claims for* \`${wallet}\` (${claims.length}):\n\n${lines.join("\n")}`;
          }
          await sendTg(chatId, reply, { parse_mode: "Markdown", disable_web_page_preview: true, message_thread_id: threadId ?? undefined });
        } catch (e) {
          await sendTg(chatId, `Failed to fetch claims: ${e.message}`, { message_thread_id: threadId ?? undefined });
        }
      }
    } catch (_) {}
    setTimeout(poll, 500);
  }
  poll();
  console.log("Telegram /claims <wallet> and /topicid (or /id) enabled — use /topicid in a topic to get its ID for TELEGRAM_CLAIM_TOPIC_ID");
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const rpc = process.env.RPC_URL_BASE || process.env.RPC_URL;
  console.log(`RPC (Base): ${rpc ? rpc.replace(/\/\/[^/:]+@/, "//***@").slice(0, 50) + (rpc.length > 50 ? "…" : "") : "not set (using mainnet.base.org)"}`);
  await registerCommands(client.application.id);
  if (WATCH_ALERT_CHANNEL_ID) {
    console.log(`Watch-list alerts will post to channel ${WATCH_ALERT_CHANNEL_ID}`);
  }
  if (ALL_LAUNCHES_CHANNEL_ID) {
    console.log(`All Bankr launches (firehose) → channel ${ALL_LAUNCHES_CHANNEL_ID}`);
  }
  if (ALERT_CHANNEL_ID) {
    console.log(`Curated launch alerts (filtered) → channel ${ALERT_CHANNEL_ID}`);
  }
  if (!ALL_LAUNCHES_CHANNEL_ID && !ALERT_CHANNEL_ID && !WATCH_ALERT_CHANNEL_ID) {
    console.log("No Discord channel IDs in env; alerts go to each server's /setup channels or notify.js webhook.");
  }
  const hasEnvChannels = ALL_LAUNCHES_CHANNEL_ID || ALERT_CHANNEL_ID || WATCH_ALERT_CHANNEL_ID;
  if (hasEnvChannels && (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID)) {
    console.log("Telegram firehose: not sending — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (and TELEGRAM_TOPIC_FIREHOSE for a topic) to get the same launches on Telegram.");
  } else if (hasEnvChannels && process.env.TELEGRAM_CHAT_ID) {
    console.log(`Telegram firehose: enabled (chat ${String(process.env.TELEGRAM_CHAT_ID).slice(0, 12)}…${process.env.TELEGRAM_TOPIC_FIREHOSE != null ? ` topic ${process.env.TELEGRAM_TOPIC_FIREHOSE}` : ""}).`);
  }

  if (DEBUG_WEBHOOK_URL) {
    try {
      const guildCount = client.guilds.cache.size;
      const stats = await getTenantStats();
      const body = JSON.stringify({
        content: `**BankrMonitor** · In **${guildCount}** Discord server(s) · **${stats.configuredGuilds}** with /setup · **${stats.guildsWithTelegram}** with Telegram`,
      });
      await fetch(DEBUG_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    } catch (e) {
      console.error("Debug webhook stats failed:", e.message);
    }
  }

  setInterval(() => {
    runNotify().catch((e) => {
      console.error("Notify failed:", e.message);
      debugLogError(e, "runNotify");
    });
  }, INTERVAL);
  runNotify().catch((e) => {
    console.error("Notify failed:", e.message);
    debugLogError(e, "runNotify");
  });

  // Real-time Doppler fee-claim firehose (Alchemy WebSocket). Every claim carries the token address;
  // claim-watch is just "when this token gets claimed" — same event, filtered by server watch lists.
  await startDopplerClaimWatcher();
  onFeeClaim(async (claim) => {
    if (isInClaimQuietWindow()) return; // skip all pings during quiet window (e.g. 8–9pm EST)

    const amt = claim.amountFormatted ?? claim.amount;
    const symbol = claim.poolSymbol ?? "Token";
    const tokenAddr = (claim.poolToken ?? "").toLowerCase();
    const tokenCa = claim.poolToken ?? ""; // full CA for copy/search
    const bankrUrl = tokenAddr ? `https://bankr.bot/launches/${tokenCa}` : null;
    const txUrl = claim.txHash ? `https://basescan.org/tx/${claim.txHash}` : null;
    const desc = [
      tokenCa ? `**Token CA:** \`${tokenCa}\`` : null,
      `**Fees:** ${amt} WETH`,
      txUrl ? `**TX:** [BaseScan](${txUrl})` : null,
    ].filter(Boolean).join("\n");
    const embed = {
      title: `💰 $${symbol} claimed`,
      description: desc,
      url: bankrUrl || undefined, // title clicks through to Bankr launch page
      color: 0x00aa00,
      timestamp: new Date().toISOString(),
    };

    const channelIds = new Set();
    if (CLAIM_FIREHOSE_CHANNEL_ID) channelIds.add(CLAIM_FIREHOSE_CHANNEL_ID);
    const tokenChannelId = tokenAddr ? CLAIM_TOKEN_CHANNELS[tokenAddr] : null;
    if (tokenChannelId) channelIds.add(tokenChannelId);

    const guildIds = await listActiveTenantGuildIds();
    for (const guildId of guildIds) {
      const tenant = await getTenant(guildId);
      const map = tenant?.claimTokenChannels ?? {};
      const chId = tokenAddr ? map[tokenAddr] : null;
      if (chId) channelIds.add(chId);
      // Claim-watch: server has this token on watch list → post to claim channel and update state
      const watchList = (tenant?.claimWatchTokens ?? []).map((a) => a.toLowerCase());
      if (watchList.includes(tokenAddr)) {
        const claimCh = tenant?.claimAlertChannelId || tenant?.watchAlertChannelId || tenant?.alertChannelId;
        if (claimCh) channelIds.add(claimCh);
        await setClaimState(guildId, tokenAddr, { lastClaimableToken: 0, lastClaimableWeth: 0, symbol }).catch(() => {});
      }
    }
    for (const cid of channelIds) {
      const ch = await client.channels.fetch(cid).catch(() => null);
      if (ch) await ch.send({ embeds: [embed] }).catch((e) => console.error("Claim send:", e.message));
    }

    const tgClaimChat = process.env.TELEGRAM_CLAIM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
    if (process.env.TELEGRAM_BOT_TOKEN && tgClaimChat) {
      await sendTelegramClaim(claim, {
        chatId: tgClaimChat,
        messageThreadId: process.env.TELEGRAM_CLAIM_TOPIC_ID,
      }).catch((e) => console.error("Telegram claim send:", e.message));
    }
  });
  if (CLAIM_FIREHOSE_CHANNEL_ID) console.log(`Claim firehose → channel ${CLAIM_FIREHOSE_CHANNEL_ID}`);
  if (Object.keys(CLAIM_TOKEN_CHANNELS).length > 0) console.log(`Claim token channels: ${Object.keys(CLAIM_TOKEN_CHANNELS).length} token(s)`);
  const tgClaimChatId = process.env.TELEGRAM_CLAIM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  const tgClaimTopic = process.env.TELEGRAM_CLAIM_TOPIC_ID;
  if (process.env.TELEGRAM_BOT_TOKEN && tgClaimChatId) {
    if (tgClaimTopic != null && String(tgClaimTopic).trim() !== "") {
      console.log(`Telegram claim alerts → chat ${String(tgClaimChatId).slice(0, 12)}… topic ${tgClaimTopic}`);
    } else {
      console.log(`Telegram claim alerts → chat ${String(tgClaimChatId).slice(0, 12)}… topic: (not set — posts to General; set TELEGRAM_CLAIM_TOPIC_ID or send /topicid in the topic)`);
    }
  }
  // Telegram /claims <wallet> command (optional)
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgAllowedIds = process.env.TELEGRAM_ALLOWED_CHAT_IDS
    ? String(process.env.TELEGRAM_ALLOWED_CHAT_IDS).split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  if (tgToken) {
    startTelegramClaimsPolling(tgToken, tgAllowedIds);
  }
});

// Prune stale lookup cache entries
function pruneLookupCache() {
  const now = Date.now();
  for (const [id, entry] of lookupCache.entries()) {
    if (now - entry.createdAt > LOOKUP_CACHE_TTL_MS) lookupCache.delete(id);
  }
}

/** Reply to a message with fees for a token (mention + address flow). Sends typing, then token fees or recipient fees. */
async function replyFeesForMessage(message, tokenAddress) {
  await message.channel.sendTyping().catch(() => {});
  try {
    const tenant = message.guildId ? await getTenant(message.guildId) : null;
    const out = await getTokenFees(tokenAddress, { bankrApiKey: tenant?.bankrApiKey ?? process.env.BANKR_API_KEY });
    if (out.claimableUnavailableReason) debugLogClaimableUnavailable(out.tokenAddress, out, "mention");
    if (out.launch) {
      await message.reply(formatFeesTokenReply(out, tokenAddress)).catch(() => {});
      return;
    }
    const recipient = await getFeesSummaryOnChainOnly(tokenAddress);
    if (recipient.tokens?.length > 0) {
      const DECIMALS = 18;
      const lines = [
        `**Fees for recipient** \`${recipient.feeWallet ?? tokenAddress}\` (on-chain claimable, no indexer)`,
        `**Bankr tokens:** ${recipient.matchCount} (showing up to ${recipient.tokens.length})`,
        "",
      ];
      for (const t of recipient.tokens) {
        const h = t.hookFees;
        const wethAmt = Number(h.beneficiaryFees0) / 10 ** DECIMALS;
        const tokenAmt = Number(h.beneficiaryFees1) / 10 ** DECIMALS;
        lines.push(`• **${t.tokenName}** ($${t.tokenSymbol}) \`${t.tokenAddress.slice(0, 10)}…\``);
        lines.push(`  Token: ${tokenAmt.toFixed(4)} · WETH: ${wethAmt.toFixed(6)}`);
        lines.push(`  [View](https://bankr.bot/launches/${t.tokenAddress})`);
      }
      lines.push("", "_Claim at [Bankr terminal](https://bankr.bot/terminal). No indexer needed — data from chain._");
      await message.reply(lines.join("\n")).catch(() => {});
      return;
    }
    await message.reply((out.error || recipient.error) || "Not a Bankr token or fee recipient, or no claimable fees found.").catch(() => {});
  } catch (e) {
    await message.reply(`Fees lookup failed: ${e.message}`).catch(() => {});
  }
}

/** Build fee reply text for a token (used by /fees-token and by mention + address). */
function formatClaimableOneLiner(hookFees, symbol) {
  const DECIMALS = 18;
  // Pool order: token0 = WETH, token1 = asset (same as indexer)
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

function fmtTokenAmount(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(0)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(4);
}

function formatFeesTokenReply(out, tokenAddress) {
  const { name, symbol, feeWallet, feeRecipient, cumulatedFees, hookFees, estimatedCreatorFeesUsd, formatUsd: fmt, error, firstSeenAt } = out;
  const feeLabel = feeRecipient?.xUsername ? `@${feeRecipient.xUsername}` : feeRecipient?.farcasterUsername ?? feeWallet ?? "—";
  if (error && !out.launch) {
    return `**${name}** ($${symbol})\n\n${error}`;
  }
  const DECIMALS = 18;
  const lines = [
    `**Token:** ${name} ($${symbol})`,
    `**CA:** \`${tokenAddress}\``,
    `**Fee recipient:** ${feeLabel}${feeWallet ? ` \`${feeWallet}\`` : ""}`,
    "",
  ];

  const hasHookData = hookFees != null;
  const claimableWeth = hasHookData ? Number(hookFees.beneficiaryFees0) / 10 ** DECIMALS : null;
  const claimableToken = hasHookData ? Number(hookFees.beneficiaryFees1) / 10 ** DECIMALS : null;
  const hasIndexerFees = cumulatedFees && (cumulatedFees.token0Fees != null || cumulatedFees.token1Fees != null || cumulatedFees.totalFeesUsd != null);
  const accruedWeth = hasIndexerFees && cumulatedFees.token0Fees != null ? Number(BigInt(cumulatedFees.token0Fees)) / 10 ** DECIMALS : null;
  const accruedToken = hasIndexerFees && cumulatedFees.token1Fees != null ? Number(BigInt(cumulatedFees.token1Fees)) / 10 ** DECIMALS : null;
  const totalFeesUsd = hasIndexerFees && cumulatedFees.totalFeesUsd != null ? Number(cumulatedFees.totalFeesUsd) : null;
  const claimsCount = out.claimedFromEvents?.count ?? 0;

  // Bankr-style Fee Revenue block
  if (hasIndexerFees || hasHookData) {
    lines.push("**Fee Revenue**");
    if (hasIndexerFees) {
      const totalEarnedParts = [];
      if (accruedWeth != null && accruedWeth > 0) totalEarnedParts.push(`${accruedWeth.toFixed(4)} WETH`);
      if (accruedToken != null && accruedToken > 0) totalEarnedParts.push(`${fmtTokenAmount(accruedToken)} ${symbol}`);
      lines.push(`**Total Earned** • ${totalEarnedParts.length ? totalEarnedParts.join(" ") : "—"}`);
    }
    if (hasHookData) {
      if ((hookFees.beneficiaryFees0 ?? 0n) > 0n || (hookFees.beneficiaryFees1 ?? 0n) > 0n) {
        const claimParts = [];
        if (hookFees.beneficiaryFees0 > 0n) claimParts.push(`${claimableWeth.toFixed(4)} WETH`);
        if (hookFees.beneficiaryFees1 > 0n) claimParts.push(`${fmtTokenAmount(claimableToken)} ${symbol}`);
        lines.push(`**Claimable** • ${claimParts.join(" • ")}`);
      } else {
        lines.push("**Claimable** • No unclaimed fees yet.");
      }
    }
    if (totalFeesUsd != null && firstSeenAt != null && firstSeenAt > 0) {
      const nowSec = Math.floor(Date.now() / 1000);
      const days = Math.max(1, (nowSec - firstSeenAt) / 86400);
      const dailyAvgUsd = totalFeesUsd / days;
      if (dailyAvgUsd >= 0 && dailyAvgUsd < 1e12) lines.push(`**Daily Average** • ${fmt(dailyAvgUsd) ?? `$${dailyAvgUsd.toFixed(0)}`}`);
    }
    const weeklyWeth = out.agentProfile?.weeklyRevenueWeth != null ? Number(out.agentProfile.weeklyRevenueWeth) : null;
    if (weeklyWeth != null && !Number.isNaN(weeklyWeth) && weeklyWeth >= 0) {
      lines.push(`**Weekly revenue (est.)** • ${weeklyWeth.toFixed(4)} WETH`);
    }
    lines.push(`**Claims** • ${claimsCount}`);
    if (out.feeWallet && out.claimedFromEvents != null) {
      lines.push(`**Fee recipient has claimed for this pool:** ${out.claimedFromEvents.count > 0 ? "Yes" : "No"}`);
      if (out.lastClaimTxHash) lines.push(`**Claim tx:** https://basescan.org/tx/${out.lastClaimTxHash}`);
    }
    lines.push("");
  }

  // Status and claim-detail (compact)
  if (hasIndexerFees && hasHookData) {
    const claimableT = claimableToken ?? 0;
    const claimableW = claimableWeth ?? 0;
    const fromEvents = out.claimedFromEvents;
    const eps = 1e-9;
    const totalClaimable = claimableW + claimableT;
    const accW = accruedWeth ?? 0;
    const accT = accruedToken ?? 0;
    const totalAccrued = accW + accT;

    if (fromEvents != null && fromEvents.count > 0) {
      if (totalClaimable < eps) lines.push("**Status:** ALL CLAIMED");
      else if (totalClaimable < totalAccrued - eps) lines.push("**Status:** PARTIALLY CLAIMED");
      else lines.push("**Status:** UNCLAIMED");
    } else if (totalAccrued >= eps) {
      if (totalClaimable >= eps) lines.push("**Status:** UNCLAIMED");
      else if (totalClaimable < eps) lines.push("**Status:** ALL CLAIMED");
      else lines.push("**Status:** _Unknown (hook reports 0 claimable; no claim events yet)_");
    }
    lines.push("");
  }

  if (hasHookData || hasIndexerFees) {
    const retrievedAt = new Date().toLocaleString("en-US", { dateStyle: "short", timeStyle: "short", timeZone: "America/New_York" });
    lines.push(`_Data retrieved: ${retrievedAt} ET_`);
    lines.push("");
  }

  if (!hasHookData && !hasIndexerFees && estimatedCreatorFeesUsd != null && estimatedCreatorFeesUsd > 0) {
    lines.push(`**Estimated** creator fees (57% of 1.2% of volume): ${fmt(estimatedCreatorFeesUsd) ?? "—"}`);
  }
  return lines.join("\n").trim();
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const mentioned = message.mentions.has(client.user?.id);
  const allAddrs = message.content.match(/0x[a-fA-F0-9]{40}/g);
  const addresses = allAddrs ? [...new Set(allAddrs.map((a) => a.toLowerCase()))] : [];
  const bankrTokens = addresses.filter((a) => a.endsWith("ba3")); // Bankr token CAs end in BA3

  if (mentioned) {
    const tokenAddress = addresses[0] ?? null;
    if (!tokenAddress) {
      await message.reply("To get fees: mention me and include a **token contract address** (0x...). Example: `@Bot 0x1234...`").catch(() => {});
      return;
    }
    await replyFeesForMessage(message, tokenAddress);
    debugLogActivity(message.guild?.name ?? message.guildId, message.author?.tag ?? "?", "mention fees", tokenAddress);
    return;
  }

  // No mention: in any channel, if message contains a Bankr token (0x...ba3), reply with rich token embed
  if (bankrTokens.length === 0) return;
  const tokenAddress = bankrTokens[0];
  await message.channel.sendTyping().catch(() => {});
  try {
    const tenant = message.guildId ? await getTenant(message.guildId) : null;
    const out = await getTokenFees(tokenAddress, { bankrApiKey: tenant?.bankrApiKey ?? process.env.BANKR_API_KEY });
    if (out.claimableUnavailableReason) debugLogClaimableUnavailable(tokenAddress, out, "paste");
    const embed = buildTokenDetailEmbed(out, tokenAddress);
    const feeParts = [];
    const claimableLine = out.hookFees && (out.hookFees.beneficiaryFees0 > 0n || out.hookFees.beneficiaryFees1 > 0n)
      ? formatClaimableOneLiner(out.hookFees, out.symbol)
      : null;
    if (claimableLine) feeParts.push(`**Claimable:** ${claimableLine}`);
    if (out.cumulatedFees && (out.cumulatedFees.token0Fees != null || out.cumulatedFees.token1Fees != null || out.cumulatedFees.totalFeesUsd != null)) {
      const DEC = 18;
      const w = Number(out.cumulatedFees.token0Fees ?? 0) / 10 ** DEC;
      const t = Number(out.cumulatedFees.token1Fees ?? 0) / 10 ** DEC;
      const fmtT = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(0)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(0)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(4);
      if (out.cumulatedFees.token0Fees != null || out.cumulatedFees.token1Fees != null) {
        feeParts.push(`**Historical accrued:** WETH ${w.toFixed(4)} • ${out.symbol ?? "Token"} ${fmtT(t)}`);
      }
      if (out.cumulatedFees.totalFeesUsd != null && out.formatUsd) {
        const usd = Number(out.cumulatedFees.totalFeesUsd);
        if (!Number.isNaN(usd) && usd >= 0 && usd < 1e12) feeParts.push(`**Total (USD):** ${out.formatUsd(out.cumulatedFees.totalFeesUsd) ?? out.cumulatedFees.totalFeesUsd}`);
      }
      if (out.hookFees && claimableLine) {
        const cW = Number(out.hookFees.beneficiaryFees0) / 10 ** DEC;
        const cT = Number(out.hookFees.beneficiaryFees1) / 10 ** DEC;
        const fromEvents = out.claimedFromEvents;
        if (fromEvents != null) {
          const claimedW = fromEvents.claimedWeth ?? 0;
          const claimedT = fromEvents.claimedToken ?? 0;
          if (claimedW > 0 || claimedT > 0) {
            feeParts.push(`**Already claimed (on-chain):** WETH ${claimedW.toFixed(4)} • Token ${fmtT(claimedT)}`);
          } else {
            feeParts.push("**Already claimed (on-chain):** 0 (no claim events detected).");
          }
        } else {
          const claimedW = Math.max(0, w - cW);
          const claimedT = Math.max(0, t - cT);
          if (claimedW > 0 || claimedT > 0) {
            feeParts.push(`**Already claimed:** WETH ${claimedW.toFixed(4)} • Token ${fmtT(claimedT)}`);
          }
        }
      } else if (out.hookFees && !claimableLine && out.claimedFromEvents != null) {
        const ev = out.claimedFromEvents;
        if ((ev.claimedWeth ?? 0) > 0 || (ev.claimedToken ?? 0) > 0) {
          feeParts.push(`**Already claimed (on-chain):** WETH ${(ev.claimedWeth ?? 0).toFixed(4)} • Token ${fmtT(ev.claimedToken ?? 0)}`);
        } else {
          feeParts.push("**Already claimed (on-chain):** 0 (no claim events detected).");
        }
      }
      if (out.feeWallet && out.claimedFromEvents != null) {
        feeParts.push(`**Fee recipient has claimed for this pool:** ${out.claimedFromEvents.count > 0 ? "Yes" : "No"}`);
        if (out.lastClaimTxHash) feeParts.push(`**Claim tx:** [BaseScan](https://basescan.org/tx/${out.lastClaimTxHash})`);
      }
      if (out.hookFees && (out.cumulatedFees.token0Fees != null || out.cumulatedFees.token1Fees != null)) {
        const cW = Number(out.hookFees.beneficiaryFees0) / 10 ** DEC;
        const cT = Number(out.hookFees.beneficiaryFees1) / 10 ** DEC;
        const eps = 1e-9;
        const totalAccrued = w + t;
        const totalClaimable = cW + cT;
        const fromEvents = out.claimedFromEvents;
        if (fromEvents != null) {
          const claimedT = fromEvents.claimedToken ?? 0;
          const claimedW = fromEvents.claimedWeth ?? 0;
          const totalClaimed = claimedT + claimedW;
          if (totalClaimed >= eps) {
            if (totalClaimable < eps) feeParts.push("**Status:** ALL CLAIMED");
            else if (totalClaimable < totalAccrued - eps) feeParts.push("**Status:** PARTIALLY CLAIMED");
            else feeParts.push("**Status:** UNCLAIMED");
          } else {
            if (totalClaimable >= eps) feeParts.push("**Status:** UNCLAIMED");
            else if (totalAccrued >= eps) feeParts.push("**Status:** _Unknown (no claim events; hook reports 0 claimable)_");
          }
        } else {
          if (totalAccrued >= eps) {
            if (totalClaimable < eps) feeParts.push("**Status:** ALL CLAIMED");
            else if (totalClaimable < totalAccrued - eps) feeParts.push("**Status:** PARTIALLY CLAIMED");
            else feeParts.push("**Status:** UNCLAIMED");
          }
        }
      }
    }
    if (out.hookFees && !claimableLine) {
      feeParts.push("**Claimable:** 0 WETH · 0 token (no unclaimed fees yet).");
    }
    if (feeParts.length > 0) {
      const retrievedAt = new Date().toLocaleString("en-US", { dateStyle: "short", timeStyle: "short", timeZone: "America/New_York" });
      feeParts.push(`_Data retrieved: ${retrievedAt} ET_`);
    } else if (out.launch) {
      if (out.estimatedCreatorFeesUsd != null && out.estimatedCreatorFeesUsd > 0 && out.formatUsd) {
        feeParts.push(`**Estimated** creator fees (57% of 1.2% of volume): ${out.formatUsd(out.estimatedCreatorFeesUsd) ?? "—"}`);
      }
      const rpcSet = !!(process.env.RPC_URL_BASE || process.env.RPC_URL);
      if (rpcSet && !out.hasPoolIdForHook) {
        feeParts.push("_RPC is set; this token's **pool ID** (bytes32) wasn't found in the Bankr API or indexer — claimable fees need it. It may appear after the pool is indexed._");
      } else if (!rpcSet) {
        feeParts.push("_No fee data yet — set **RPC_URL_BASE** (Base RPC) in the bot env for on-chain claimable._");
      } else {
        feeParts.push("_No fee data yet for this pool. Volume and historical fees usually appear in the indexer within a few minutes of the first swap; claimable uses on-chain data when RPC is set._");
      }
      const retrievedAt = new Date().toLocaleString("en-US", { dateStyle: "short", timeStyle: "short", timeZone: "America/New_York" });
      feeParts.push(`_Data retrieved: ${retrievedAt} ET_`);
    }
    if (feeParts.length > 0 && embed.fields) {
      embed.fields.splice(3, 0, { name: "Fees", value: feeParts.join("\n"), inline: false });
    }
    await message.reply({ embeds: [embed] }).catch(() => {});
    debugLogActivity(message.guild?.name ?? message.guildId, message.author?.tag ?? "?", "paste token", tokenAddress);
  } catch (e) {
    console.error("Token paste failed:", e.message);
    debugLogError(e, "messageCreate paste");
    await message.reply(`Token lookup failed: ${e.message}`).catch(() => {});
  }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton() && (interaction.customId === "lookup:prev" || interaction.customId === "lookup:next")) {
    pruneLookupCache();
    const entry = lookupCache.get(interaction.message?.id);
    if (!entry) {
      await interaction.reply({ content: "This lookup has expired. Run /lookup again." }).catch(() => {});
      return;
    }
    const totalPages = Math.ceil(entry.matches.length / LOOKUP_PAGE_SIZE) || 1;
    let nextPage = entry.currentPage;
    if (interaction.customId === "lookup:next" && entry.currentPage < totalPages - 1) nextPage = entry.currentPage + 1;
    if (interaction.customId === "lookup:prev" && entry.currentPage > 0) nextPage = entry.currentPage - 1;
    entry.currentPage = nextPage;
    entry.createdAt = Date.now();
    const embed = buildLookupEmbed(entry, nextPage);
    const components = buildLookupButtons(entry, nextPage);
    await interaction.update({ embeds: [embed], components }).catch(() => {});
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "wallet-lookup") {
    const query = interaction.options.getString("query");
    await interaction.deferReply();
    try {
      const tenant = interaction.guildId ? await getTenant(interaction.guildId) : null;
      const apiKey = tenant?.bankrApiKey ?? process.env.BANKR_API_KEY;
      const { wallet, normalized, isWallet } = await resolveHandleToWallet(query, { bankrApiKey: apiKey });
      if (wallet) {
        await interaction.editReply({
          content:
            (isWallet ? `**Wallet:** \`${wallet}\`\n\n` : `**Wallet for ${normalized}:** \`${wallet}\`\n\n`) +
            "Use **/lookup** with the same handle or wallet to see token deployments.",
        });
      } else {
        await interaction.editReply({
          content:
            `Could not resolve a wallet for **${normalized || query}**. ` +
            "We only know wallets from launches where this X or Farcaster is deployer or fee recipient (BANKR_API_KEY required). " +
            "If this account has received tokens on Bankr, try **/lookup** with the same handle—sometimes tokens appear there. " +
            "Otherwise use the wallet address (0x...) directly.",
        });
      }
      debugLogActivity(interaction.guild?.name ?? interaction.guildId, interaction.user?.tag ?? "?", "/wallet-lookup", query);
    } catch (e) {
      console.error("Wallet lookup failed:", e.message);
      debugLogError(e, "wallet-lookup");
      await interaction.editReply({ content: `Resolve failed: ${e.message}` }).catch(() => {});
    }
    return;
  }

  if (interaction.commandName === "lookup") {
    const query = interaction.options.getString("query");
    const by = interaction.options.getString("by") || "both";
    await interaction.deferReply();
    try {
      const tenant = interaction.guildId ? await getTenant(interaction.guildId) : null;
      const apiKey = tenant?.bankrApiKey ?? process.env.BANKR_API_KEY;
      const { matches, totalCount, normalized, possiblyCapped, resolvedWallet } = await lookupByDeployerOrFee(query, by, "newest", { bankrApiKey: apiKey });
      const searchQ = normalized || String(query).trim();
      const searchUrl = resolvedWallet
        ? `https://bankr.bot/launches/search?q=${encodeURIComponent(resolvedWallet)}`
        : `https://bankr.bot/launches/search?q=${encodeURIComponent(searchQ)}`;
      if (matches.length === 0) {
        const isWalletQuery = /^0x[a-fA-F0-9]{40}$/.test(String(searchQ).trim());
        const inGuild = !!interaction.guildId;
        let hint = "";
        if (!isWalletQuery && !resolvedWallet) {
          hint = "\n\nCouldn't resolve this handle to a wallet. Ask your server admin to set an API key in **/setup** (from [bankr.bot/api](https://bankr.bot/api)) so the bot can resolve X/Farcaster handles and search by wallet.";
        } else if (isWalletQuery) {
          hint = inGuild
            ? "\n\nIf the link above shows results on Bankr, ask your server admin to set an API key in **/setup** so lookup can use the list API."
            : "\n\nIf the link above shows results on Bankr, set **BANKR_API_KEY** (from [bankr.bot/api](https://bankr.bot/api)) in this bot's env so lookup can use the list API.";
        }
        await interaction.editReply({
          content: `No Bankr tokens found for **${searchQ}**.\nFull search: ${searchUrl}${hint}`,
        });
        debugLogActivity(interaction.guild?.name ?? interaction.guildId, interaction.user?.tag ?? "?", "/lookup", `${searchQ} (0 results)`);
        return;
      }
      const data = {
        matches,
        query,
        by,
        searchUrl,
        totalCount,
        possiblyCapped,
        resolvedWallet: resolvedWallet ?? null,
        currentPage: 0,
        createdAt: Date.now(),
      };
      const embed = buildLookupEmbed(data, 0);
      const payload = { embeds: [embed] };
      if (matches.length > LOOKUP_PAGE_SIZE) {
        payload.components = buildLookupButtons(data, 0);
      }
      const msg = await interaction.editReply(payload);
      if (msg && matches.length > LOOKUP_PAGE_SIZE) lookupCache.set(msg.id, data);
      debugLogActivity(interaction.guild?.name ?? interaction.guildId, interaction.user?.tag ?? "?", "/lookup", `${searchQ} (${totalCount} tokens)`);
    } catch (e) {
      console.error("Lookup failed:", e.message);
      debugLogError(e, "lookup");
      await interaction.editReply({ content: `Lookup failed: ${e.message}` }).catch(() => {});
    }
    return;
  }

  if (interaction.commandName === "help") {
    const embed = {
      color: 0x0052_ff,
      title: "BankrMonitor – How to use",
      description:
        "This bot helps you **watch** Bankr launches and **look up** tokens by wallet/X/Farcaster." +
        (HIDE_DEPLOY_COMMAND ? "" : " You can also **deploy** Bankr tokens from Discord.") +
        " Data: Bankr API.",
      fields: [
        {
          name: "📋 /watch",
          value:
            "**add** – Add to watch list (type: X, Farcaster, wallet, or keyword + value). Optional **name** = nickname/label. **edit** – Change the nickname of an existing entry (type + value + new name; leave name empty to clear). **remove** – Remove by type + value. X and Farcaster are resolved to wallet first.\n" +
            "**remove** – Remove by type + value.\n**list** – Show current watch list.",
          inline: false,
        },
        {
          name: "🔍 /lookup",
          value:
            "**Deployment info:** Search Bankr tokens by **deployer** or **fee recipient**.\n" +
            "**query:** wallet (`0x...`), X handle (`@user` or x.com/user/...), or Farcaster (handle or farcaster.xyz/...). X/FC are resolved to wallet first, then tokens are shown.\n" +
            "**by:** Deployer / Fee recipient / Both (default).\n" +
            "Shows tokens + link to [full list on Bankr](https://bankr.bot/launches/search). Pagination when there are more than 5.",
          inline: false,
        },
        {
          name: "🔗 /wallet-lookup",
          value:
            "**Wallet lookup:** Get the wallet address for an X or Farcaster account (from Bankr launch data).\n" +
            "**query:** X handle, Farcaster handle, or profile URL. Use **/lookup** with the same handle to see their token deployments.",
          inline: false,
        },
        ...(HIDE_DEPLOY_COMMAND ? [] : [
          {
            name: "🚀 /deploy",
            value:
              "**Deploy a Bankr token** from Discord.\n" +
              "**name** (required), **symbol**, **description**, **image_url**, **website_url**, **tweet_url**.\n" +
              "**Fee recipient:** wallet (0x…), X handle, Farcaster handle, or ENS — set type + value to send 57% creator fees there. Otherwise fees go to the API key wallet.\n" +
              "**simulate_only:** dry run. Requires **BANKR_API_KEY** with Agent API (write) access at [bankr.bot/api](https://bankr.bot/api). Rate limit: 50 deploys/24h.",
            inline: false,
          },
        ]),
        {
          name: "💰 /fees-token",
          value:
            "**Accrued/claimable fees** for one Bankr token.\n" +
            "**token:** Token address (0x…) or Bankr launch URL (e.g. bankr.bot/launches/0x…). Shows fee recipient, indexer accrued fees (token + WETH + USD) when available, or estimated from volume. Claimed vs unclaimed is not in the API — use [Bankr terminal](https://bankr.bot/terminal) or `bankr fees --token <ca>` to see/claim.",
          inline: false,
        },
        {
          name: "🔔 /claim-watch",
          value:
            "**Get notified when a token's fees are claimed.** **add** — Token address (0x…) + optional **name** (label). **remove** — By address or label. **list** — Shows tokens with symbol/label. Alerts post to the server's claim channel (or watch/alert channel). Run **/setup** first.",
          inline: false,
        },
        {
          name: "📋 /claims-for-wallet",
          value:
            "**List Bankr tokens a wallet has claimed** (fee claims only). **wallet** — Address (0x…). Returns token symbol, Bankr link, WETH amount, and BaseScan TX link for each claim.",
          inline: false,
        },
        {
          name: "🔎 /claims-for-token",
          value:
            "**List wallets that have claimed this token** (historical RPC getLogs). **token** — Address (0x…ba3) or Bankr URL. If RPC finds none, checks BaseScan for fee recipient claim txs.",
          inline: false,
        },
        {
          name: "📢 /claim-channel",
          value:
            "**Send claim alerts for a token to a specific channel.** **add** — Token (0x…ba3) + channel; when that token is claimed, post to that channel. **remove** / **list** — Manage mappings. Firehose filter by token.",
          inline: false,
        },
        {
          name: "📌 Channels & paste",
          value:
            "**/setup** — **All launches** = firehose (every Bankr deploy). **Curated** = only launches that pass your rules (same X/FC on deployer + fee recipient, max deploys/day). **Watch** = only your **/watch** list. **Claim channel** = fee-claim alerts only (else uses watch/alert).\n" +
            "**Paste a Bankr token** (any channel): address ending in **BA3** → bot replies with name, symbol, link, fees.",
          inline: false,
        },
      ],
      footer: { text: "Bankr: bankr.bot" },
    };
    await interaction.reply({ embeds: [embed] }).catch(() => {});
    return;
  }

  if (interaction.commandName === "deploy") {
    if (HIDE_DEPLOY_COMMAND) {
      await interaction.reply({
        content: "Deploy is temporarily unavailable.",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }
    if (interaction.guildId && !canManageServer(interaction)) {
      await interaction.reply({
        content: "Only server admins (Manage Server permission) can run **/deploy**.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const name = interaction.options.getString("name");
    const symbol = interaction.options.getString("symbol");
    const description = interaction.options.getString("description");
    const imageUrl = interaction.options.getString("image_url");
    const websiteUrl = interaction.options.getString("website_url");
    const tweetUrl = interaction.options.getString("tweet_url");
    const feeType = interaction.options.getString("fee_recipient_type");
    const feeValue = interaction.options.getString("fee_recipient_value");
    const simulateOnly = interaction.options.getBoolean("simulate_only") ?? false;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (feeType && !feeValue?.trim()) {
        await interaction.editReply({
          content: "If you set **fee recipient type**, you must also set **fee recipient value** (address, @handle, or ENS).",
        });
        return;
      }
      const body = buildDeployBody({
        tokenName: name,
        tokenSymbol: symbol || undefined,
        description: description || undefined,
        image: imageUrl || undefined,
        websiteUrl: websiteUrl || undefined,
        tweetUrl: tweetUrl || undefined,
        feeRecipient: feeType && feeValue ? { type: feeType, value: feeValue } : undefined,
        simulateOnly,
      });
      const result = await callBankrDeploy(body, { bankrApiKey: interaction.guildId ? (await getTenant(interaction.guildId))?.bankrApiKey : undefined });
      if (result.simulated) {
        await interaction.editReply({
          content: `**Simulated deploy** (no tx broadcast).\nPredicted token address: \`${result.tokenAddress ?? "—"}\``,
        });
        debugLogActivity(interaction.guild?.name ?? interaction.guildId, interaction.user?.tag ?? "?", "/deploy", "simulate");
        return;
      }
      const tokenAddr = result.tokenAddress ?? "";
      const launchUrl = tokenAddr ? `https://bankr.bot/launches/${tokenAddr}` : "https://bankr.bot/launches";
      const lines = [
        result.tokenAddress ? `**Token:** \`${result.tokenAddress}\`` : "",
        result.poolId ? `**Pool ID:** \`${result.poolId}\`` : "",
        result.txHash ? `**Tx:** [BaseScan](${`https://basescan.org/tx/${result.txHash}`})` : "",
        `**Launch:** [View on Bankr](${launchUrl})`,
      ].filter(Boolean);
      const rl = result.rateLimit;
      const footerParts = ["Bankr deploy API • Creator fees 57%"];
      if (rl?.remaining != null && !Number.isNaN(rl.remaining)) {
        const limit = rl.limit != null && !Number.isNaN(rl.limit) ? rl.limit : 50;
        footerParts.push(` • ${rl.remaining} deploys left in 24h (of ${limit})`);
      } else {
        footerParts.push(" • Limit: 50/24h (Bankr Club: 100)");
      }
      const embed = {
        color: 0x0052_ff,
        title: "Token deployed",
        description: lines.join("\n"),
        footer: { text: footerParts.join("") },
      };
      await interaction.editReply({ embeds: [embed] });
      debugLogActivity(interaction.guild?.name ?? interaction.guildId, interaction.user?.tag ?? "?", "/deploy", result.tokenAddress ?? "ok");
    } catch (e) {
      console.error("Deploy failed:", e.message);
      debugLogError(e, "deploy");
      await interaction.editReply({ content: `Deploy failed: ${e.message}` }).catch(() => {});
    }
    return;
  }

  if (interaction.commandName === "fees-token") {
    const tokenInput = interaction.options.getString("token");
    const addrMatch = tokenInput && tokenInput.match(/0x[a-fA-F0-9]{40}/);
    const tokenAddress = addrMatch ? addrMatch[0].toLowerCase() : null;
    if (!tokenAddress) {
      await interaction.reply({
        content: "Provide a token address (0x...) or a Bankr launch URL (e.g. https://bankr.bot/launches/0x...).",
      });
      return;
    }
    await interaction.deferReply();
    try {
      const tenant = interaction.guildId ? await getTenant(interaction.guildId) : null;
      const out = await getTokenFees(tokenAddress, { bankrApiKey: tenant?.bankrApiKey ?? process.env.BANKR_API_KEY });
      if (out.claimableUnavailableReason) debugLogClaimableUnavailable(out.tokenAddress, out, "fees-token");
      const content = formatFeesTokenReply(out, tokenAddress);
      await interaction.editReply({ content });
      debugLogActivity(interaction.guild?.name ?? interaction.guildId, interaction.user?.tag ?? "?", "/fees-token", tokenAddress);
    } catch (e) {
      console.error("Fees-token failed:", e.message);
      debugLogError(e, "fees-token");
      await interaction.editReply({ content: `Fees lookup failed: ${e.message}` }).catch(() => {});
    }
    return;
  }

  if (interaction.commandName === "bankr-whales") {
    const limit = interaction.options.getInteger("limit") ?? 10;
    await interaction.deferReply();
    try {
      const { rows, source } = await fetchTopFeeEarners(limit);
      if (rows.length === 0) {
        await interaction.editReply("No fee-earner data from the indexer right now. Try again later or check DOPPLER_INDEXER_URL.");
        return;
      }
      const title = source === "v4pools" ? "**Top Bankr Fee Recipients** (by pool volume)\n" : "**Top Bankr Fee Earners** (all-time)\n";
      const lines = [title];
      rows.forEach((r, i) => {
        const short = `${r.wallet.slice(0, 6)}…${r.wallet.slice(-4)}`;
        const usd = formatUsd(r.totalUsd) ?? `$${r.totalUsd.toFixed(0)}`;
        const wethStr = r.weth > 0 ? `\n   ${r.weth.toFixed(4)} WETH` : "";
        lines.push(`${i + 1}. \`${short}\`\n   ${usd}${wethStr}`);
      });
      const footer = source === "v4pools"
        ? "\n_By pool volume (indexer may not expose fee totals) · [Bankr](https://bankr.bot)_"
        : "\n_Data from Doppler Indexer · [Bankr](https://bankr.bot)_";
      lines.push(footer);
      await interaction.editReply(lines.join("\n"));
      debugLogActivity(interaction.guild?.name ?? interaction.guildId, interaction.user?.tag ?? "?", "/bankr-whales", `${rows.length}`);
    } catch (e) {
      console.error("bankr-whales failed:", e.message);
      debugLogError(e, "bankr-whales");
      await interaction.editReply({ content: `Leaderboard failed: ${e.message}` }).catch(() => {});
    }
    return;
  }

  if (interaction.commandName === "setup") {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        content: "Setup is only available in a server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!canManageServer(interaction)) {
      await interaction.reply({
        content: "Only server admins (Manage Server permission) can run **/setup**.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const apiKey = interaction.options.getString("api_key")?.trim();
      const allLaunchesChannel = interaction.options.getChannel("all_launches_channel");
      const alertChannel = interaction.options.getChannel("alert_channel");
      const watchChannel = interaction.options.getChannel("watch_channel");
      const claimChannel = interaction.options.getChannel("claim_channel");
      const hotChannel = interaction.options.getChannel("hot_channel");
      const hotEnabled = interaction.options.getBoolean("hot_enabled");
      const hotPingRoleIdsRaw = interaction.options.getString("hot_ping_role_ids");
      const pingOnHotOpt = interaction.options.getBoolean("ping_on_hot");
      const pingOnTrendingOpt = interaction.options.getBoolean("ping_on_trending");
      const pingOnWatchMatchOpt = interaction.options.getBoolean("ping_on_watch_match");
      const pingOnCuratedOpt = interaction.options.getBoolean("ping_on_curated");
      const trendingChannel = interaction.options.getChannel("trending_channel");
      const trendingEnabled = interaction.options.getBoolean("trending_enabled");
      const filterXMatch = interaction.options.getBoolean("filter_x_match") ?? false;
      const filterFeeRecipientHasX = interaction.options.getBoolean("filter_fee_recipient_has_x") ?? false;
      const filterMaxDeploys = interaction.options.getInteger("filter_max_deploys");
      const pollIntervalMin = interaction.options.getNumber("poll_interval_min");
      if (!apiKey) {
        await interaction.editReply({
          content: "Provide **api_key**. Get a key at [bankr.bot/api](https://bankr.bot/api).",
        });
        return;
      }
      if (!allLaunchesChannel && !alertChannel) {
        await interaction.editReply({
          content:
            "Set at least one launch channel: **all_launches_channel** (every Bankr deploy) and/or **alert_channel** (curated — rules below). Watch channel is optional.",
        });
        return;
      }
      const hotLaunchRoleIds = parseRoleIdsFromInput(hotPingRoleIdsRaw);
      const updates = {
        bankrApiKey: apiKey,
        allLaunchesChannelId: allLaunchesChannel?.id ?? null,
        alertChannelId: alertChannel?.id ?? null,
        watchAlertChannelId: watchChannel?.id ?? null,
        claimAlertChannelId: claimChannel?.id ?? null,
        hotAlertChannelId: hotChannel?.id ?? null,
        hotLaunchEnabled: hotEnabled !== false,
        hotLaunchRoleIds: hotLaunchRoleIds ?? [],
        pingOnHot: pingOnHotOpt ?? true,
        pingOnTrending: pingOnTrendingOpt ?? true,
        pingOnWatchMatch: pingOnWatchMatchOpt ?? false,
        pingOnCurated: pingOnCuratedOpt ?? false,
        trendingAlertChannelId: trendingChannel?.id ?? null,
        trendingEnabled: trendingEnabled === true,
        rules: {
          filterXMatch,
          filterFeeRecipientHasX,
          filterMaxDeploys: filterMaxDeploys != null ? filterMaxDeploys : null,
          pollIntervalMs: pollIntervalMin != null ? Math.max(0.5, pollIntervalMin) * 60_000 : 60_000,
        },
      };
      await setTenant(guildId, updates);
      const lines = [
        "**Server config saved.**",
        allLaunchesChannel ? `• **All launches** (firehose): ${allLaunchesChannel.name}` : "• All launches channel: (none)",
        alertChannel ? `• **Curated** (rules): ${alertChannel.name}` : "• Curated channel: (none)",
        watchChannel ? `• **Watch list**: ${watchChannel.name}` : "• Watch channel: (none)",
        claimChannel ? `• **Claim alerts**: ${claimChannel.name}` : "• Claim alerts: (use watch/alert channel)",
        hotChannel ? `• **Hot tokens**: ${hotChannel.name} (${updates.hotLaunchEnabled ? "on" : "off"})` : "• Hot tokens: (none)",
        trendingChannel ? `• **Trending**: ${trendingChannel.name} (${updates.trendingEnabled ? "on" : "off"})` : "• Trending: (none)",
        updates.hotLaunchRoleIds?.length > 0 ? `• **Ping roles**: ${updates.hotLaunchRoleIds.length} role(s)` : "• Ping roles: (none)",
        `• **Ping when:** hot ${updates.pingOnHot !== false} · trending ${updates.pingOnTrending !== false} · watch ${updates.pingOnWatchMatch === true} · curated ${updates.pingOnCurated === true}`,
        `• Filter X match (curated): ${filterXMatch}`,
        filterMaxDeploys != null ? `• Max deploys/day (curated): ${filterMaxDeploys}` : "• Max deploys/day: no limit",
        `• Poll interval: ${updates.rules.pollIntervalMs / 60_000} min`,
        "",
        "**Tip:** Firehose = every deploy. Curated = only passes rules (X match, fee recipient has X, max deploys/day). **/watch** = your list only.",
        "Use **/watch add** for X, Farcaster, wallets, keywords. **/settings show** to view.",
      ];
      await interaction.editReply({ content: lines.filter(Boolean).join("\n") });
    } catch (e) {
      await interaction.editReply({ content: `Setup failed: ${e.message}` }).catch(() => {});
    }
    return;
  }

  if (interaction.commandName === "settings") {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        content: "Settings are only available in a server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!canManageServer(interaction)) {
      await interaction.reply({
        content: "Only server admins (Manage Server permission) can run **/settings**.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (sub === "show") {
        const tenant = await getTenant(guildId);
        if (!tenant) {
          await interaction.editReply({
            content: "No config for this server yet. Run **/setup** to configure API key, channels, and rules.",
          });
          return;
        }
        const w = tenant.watchlist || {};
        const lines = [
          "**Current config** (API key hidden)",
          `• **All launches** (firehose): ${tenant.allLaunchesChannelId ? `<#${tenant.allLaunchesChannelId}>` : "—"}`,
          `• **Curated** (rules): ${tenant.alertChannelId ? `<#${tenant.alertChannelId}>` : "—"}`,
          `• **Watch list**: ${tenant.watchAlertChannelId ? `<#${tenant.watchAlertChannelId}>` : "—"}`,
          `• **Claim alerts**: ${tenant.claimAlertChannelId ? `<#${tenant.claimAlertChannelId}>` : "—"} (or watch/alert)`,
          `• **Hot tokens**: ${tenant.hotAlertChannelId ? `<#${tenant.hotAlertChannelId}>` : "—"} ${tenant.hotLaunchEnabled !== false ? "(on)" : "(off)"}`,
          (tenant.claimWatchTokens?.length ?? 0) > 0 ? `• **Claim watch**: ${tenant.claimWatchTokens.length} token(s) — use **/claim-watch list**` : "• **Claim watch**: (none)",
          (Object.keys(tenant.claimTokenChannels || {}).length > 0) ? `• **Claim channel** (token→channel): ${Object.keys(tenant.claimTokenChannels).length} — **/claim-channel list**` : "• **Claim channel** (token→channel): (none)",
          (tenant.hotLaunchRoleIds?.length ?? 0) > 0 ? `• **Ping roles**: ${tenant.hotLaunchRoleIds.length} role(s)` : "• Ping roles: (none)",
          `• **Ping when:** hot ${tenant.pingOnHot !== false} · trending ${tenant.pingOnTrending !== false} · watch ${tenant.pingOnWatchMatch === true} · curated ${tenant.pingOnCurated === true}`,
          `• **Trending**: ${tenant.trendingAlertChannelId ? `<#${tenant.trendingAlertChannelId}>` : "—"} ${tenant.trendingEnabled ? "(on)" : "(off)"}`,
          `• Filter X match: ${tenant.rules?.filterXMatch ?? false}`,
          `• Filter fee recipient has X: ${tenant.rules?.filterFeeRecipientHasX ?? false}`,
          `• Max deploys/day: ${tenant.rules?.filterMaxDeploys ?? "—"}`,
          `• Poll interval: ${((tenant.rules?.pollIntervalMs ?? 60000) / 60_000)} min`,
          "• Watchlist: X " + (w.x?.length ?? 0) + ", FC " + (w.fc?.length ?? 0) + ", wallets " + (w.wallet?.length ?? 0) + ", keywords " + (w.keywords?.length ?? 0),
          "",
          tenant.telegramChatId
            ? `• **Telegram:** group \`${String(tenant.telegramChatId).slice(0, 12)}…\` · All launches ${tenant.telegramTopicFirehose ?? "—"} · X only fee recipient ${tenant.telegramTopicCurated ?? "—"} · Hot ${tenant.telegramTopicHot ?? "—"} · Trending ${tenant.telegramTopicTrending ?? "—"} · Hot/trending delay ${tenant.telegramHotPingDelayMs != null ? `${tenant.telegramHotPingDelayMs / 1000}s` : "(env)"}`
            : "• **Telegram:** (none)",
          "Use **/settings api_key**, **/settings channels**, **/settings rules**, **/settings pings**, or **/settings telegram** to edit.",
        ];
        await interaction.editReply({ content: lines.join("\n") });
        return;
      }
      if (sub === "telegram") {
        const groupChatId = interaction.options.getString("group_chat_id")?.trim();
        const topicFirehose = interaction.options.getString("topic_firehose")?.trim();
        const topicCurated = interaction.options.getString("topic_curated")?.trim();
        const topicHot = interaction.options.getString("topic_hot")?.trim();
        const topicTrending = interaction.options.getString("topic_trending")?.trim();
        const delaySec = interaction.options.getInteger("delay_hot_trending_sec");
        const opts = interaction.options.data.options || [];
        const updates = {};
        if (opts.find((o) => o.name === "group_chat_id")) updates.telegramChatId = groupChatId || null;
        if (opts.find((o) => o.name === "topic_firehose")) updates.telegramTopicFirehose = topicFirehose ? (parseInt(topicFirehose, 10) || topicFirehose) : null;
        if (opts.find((o) => o.name === "topic_curated")) updates.telegramTopicCurated = topicCurated ? (parseInt(topicCurated, 10) || topicCurated) : null;
        if (opts.find((o) => o.name === "topic_hot")) updates.telegramTopicHot = topicHot ? (parseInt(topicHot, 10) || topicHot) : null;
        if (opts.find((o) => o.name === "topic_trending")) updates.telegramTopicTrending = topicTrending ? (parseInt(topicTrending, 10) || topicTrending) : null;
        if (opts.find((o) => o.name === "delay_hot_trending_sec")) updates.telegramHotPingDelayMs = delaySec != null ? Math.max(0, delaySec) * 1000 : null;
        if (Object.keys(updates).length === 0) {
          await interaction.editReply({
            content:
              "Provide **group_chat_id**, topic IDs (**topic_firehose**, **topic_curated**, **topic_hot**, **topic_trending**), and/or **delay_hot_trending_sec** (seconds to delay Hot/Trending pings to Telegram after Discord). Create a Telegram group, enable Topics, then get the group ID and each topic's thread ID.",
          });
          return;
        }
        await setTenant(guildId, updates);
        await interaction.editReply({ content: "Telegram settings updated." });
        return;
      }
      if (sub === "pings") {
        const pingOnHot = interaction.options.getBoolean("ping_on_hot");
        const pingOnTrending = interaction.options.getBoolean("ping_on_trending");
        const pingOnWatchMatch = interaction.options.getBoolean("ping_on_watch_match");
        const pingOnCurated = interaction.options.getBoolean("ping_on_curated");
        const updates = {};
        if (pingOnHot !== null) updates.pingOnHot = pingOnHot;
        if (pingOnTrending !== null) updates.pingOnTrending = pingOnTrending;
        if (pingOnWatchMatch !== null) updates.pingOnWatchMatch = pingOnWatchMatch;
        if (pingOnCurated !== null) updates.pingOnCurated = pingOnCurated;
        if (Object.keys(updates).length === 0) {
          await interaction.editReply({ content: "Provide at least one option: **ping_on_hot**, **ping_on_trending**, **ping_on_watch_match**, **ping_on_curated**." });
          return;
        }
        await setTenant(guildId, updates);
        await interaction.editReply({ content: "Ping settings updated." });
        return;
      }
      if (sub === "api_key") {
        const key = interaction.options.getString("key")?.trim();
        if (!key) {
          await interaction.editReply({ content: "Provide a key." });
          return;
        }
        await setTenant(guildId, { bankrApiKey: key });
        await interaction.editReply({ content: "API key updated." });
        return;
      }
      if (sub === "channels") {
        const allLaunchesChannel = interaction.options.getChannel("all_launches_channel");
        const alertChannel = interaction.options.getChannel("alert_channel");
        const watchChannel = interaction.options.getChannel("watch_channel");
        const claimChannel = interaction.options.getChannel("claim_channel");
        const hotChannel = interaction.options.getChannel("hot_channel");
        const hotEnabled = interaction.options.getBoolean("hot_enabled");
        const hotPingRoleIdsRaw = interaction.options.getString("hot_ping_role_ids");
        const trendingChannel = interaction.options.getChannel("trending_channel");
        const trendingEnabled = interaction.options.getBoolean("trending_enabled");
        const updates = {};
        if (allLaunchesChannel) updates.allLaunchesChannelId = allLaunchesChannel.id;
        if (alertChannel) updates.alertChannelId = alertChannel.id;
        if (interaction.options.data.options?.find((o) => o.name === "watch_channel")) {
          updates.watchAlertChannelId = watchChannel?.id ?? null;
        }
        if (interaction.options.data.options?.find((o) => o.name === "claim_channel")) {
          updates.claimAlertChannelId = claimChannel?.id ?? null;
        }
        if (interaction.options.data.options?.find((o) => o.name === "hot_channel")) {
          updates.hotAlertChannelId = hotChannel?.id ?? null;
        }
        if (interaction.options.data.options?.find((o) => o.name === "hot_enabled") !== undefined) {
          updates.hotLaunchEnabled = hotEnabled !== false;
        }
        if (interaction.options.data.options?.find((o) => o.name === "hot_ping_role_ids") !== undefined) {
          updates.hotLaunchRoleIds = parseRoleIdsFromInput(hotPingRoleIdsRaw);
        }
        if (interaction.options.data.options?.find((o) => o.name === "trending_channel")) {
          updates.trendingAlertChannelId = trendingChannel?.id ?? null;
        }
        if (interaction.options.data.options?.find((o) => o.name === "trending_enabled") !== undefined) {
          updates.trendingEnabled = trendingEnabled === true;
        }
        if (Object.keys(updates).length === 0) {
          await interaction.editReply({
            content:
              "Pick at least one channel to set. **all_launches_channel** = every deploy; **alert_channel** = curated; **watch_channel** / **claim_channel** / **hot_channel** / **trending_channel** optional.",
          });
          return;
        }
        await setTenant(guildId, updates);
        await interaction.editReply({ content: "Channels updated." });
        return;
      }
      if (sub === "rules") {
        const filterXMatch = interaction.options.getBoolean("filter_x_match");
        const filterFeeRecipientHasX = interaction.options.getBoolean("filter_fee_recipient_has_x");
        const filterMaxDeploys = interaction.options.getInteger("filter_max_deploys");
        const pollIntervalMin = interaction.options.getNumber("poll_interval_min");
        const tenant = await getTenant(guildId);
        const rules = { ...(tenant?.rules ?? {}) };
        if (filterXMatch !== null) rules.filterXMatch = filterXMatch;
        if (filterFeeRecipientHasX !== null) rules.filterFeeRecipientHasX = filterFeeRecipientHasX;
        if (filterMaxDeploys !== null) rules.filterMaxDeploys = filterMaxDeploys;
        if (pollIntervalMin != null) rules.pollIntervalMs = Math.max(0.5, pollIntervalMin) * 60_000;
        await setTenant(guildId, { rules });
        await interaction.editReply({ content: "Rules updated." });
        return;
      }
    } catch (e) {
      await interaction.editReply({ content: `Settings failed: ${e.message}` }).catch(() => {});
    }
    return;
  }

  if (interaction.commandName === "claim-watch") {
    const guildId = interaction.guildId ?? null;
    const tenant = guildId ? await getTenant(guildId) : null;
    const sub = interaction.options.getSubcommand();

    if (!guildId || !tenant || (!tenant.allLaunchesChannelId && !tenant.alertChannelId && !tenant.watchAlertChannelId)) {
      await interaction.reply({
        content: "Claim watch is available per server. Run **/setup** first (API key + at least one launch/watch channel), then use **/claim-watch add** with a token address.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if ((sub === "add" || sub === "remove") && !canManageServer(interaction)) {
      await interaction.reply({
        content: "Only server admins (Manage Server permission) can **add** or **remove** tokens from the claim watch list. Use **/claim-watch list** to view.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      if (sub === "add") {
        const tokenAddress = interaction.options.getString("token_address");
        const name = interaction.options.getString("name")?.trim();
        const addr = tokenAddress && /^0x[a-fA-F0-9]{40}$/.test(tokenAddress.trim()) ? tokenAddress.trim().toLowerCase() : null;
        if (!addr) {
          await interaction.reply({ content: "Invalid token address. Use 0x followed by 40 hex characters.", flags: MessageFlags.Ephemeral });
          return;
        }
        const added = await addClaimWatchToken(guildId, addr, name || undefined);
        const channelHint = tenant?.claimAlertChannelId || tenant?.watchAlertChannelId || tenant?.alertChannelId ? " in this server's claim/watch/alert channel" : "";
        await interaction.reply({
          content: added
            ? (name ? `Added **${name}** (\`${addr}\`) to the claim watch list.` : `Added \`${addr}\` to the claim watch list.`)
            + ` You'll be notified when its fees are claimed${channelHint}.`
            : (name ? `**${name}** (\`${addr}\`) is already on the claim watch list; label updated.` : "That token is already on the claim watch list."),
          flags: MessageFlags.Ephemeral,
        });
      } else if (sub === "remove") {
        const tokenAddressOrLabel = interaction.options.getString("token_address")?.trim();
        const ok = tokenAddressOrLabel ? await removeClaimWatchToken(guildId, tokenAddressOrLabel) : false;
        await interaction.reply({
          content: ok ? "Removed that token from the claim watch list." : "Token not found. Use the exact address (0x...) or the label you set when adding.",
          flags: MessageFlags.Ephemeral,
        });
      } else if (sub === "list") {
        const list = await getClaimWatchTokens(guildId);
        if (list.length === 0) {
          await interaction.reply({ content: "Claim watch list is empty. Use **/claim-watch add** with a token address.", flags: MessageFlags.Ephemeral });
          return;
        }
        const tenant = await getTenant(guildId);
        const labels = tenant?.claimWatchLabels || {};
        const withSymbol = await Promise.all(
          list.map(async (addr) => {
            const state = await getClaimState(guildId, addr);
            const symbol = state?.symbol ?? "—";
            const label = labels[addr];
            if (label) return `• **${label}** ($${symbol}) · \`${addr}\``;
            if (symbol !== "—") return `• $${symbol} · \`${addr}\``;
            return `• \`${addr}\``;
          })
        );
        await interaction.reply({
          content: `**Claim watch list** (${list.length} token${list.length === 1 ? "" : "s"}):\n\n${withSymbol.join("\n")}\n\nYou'll be notified when fees are claimed for any of these tokens. Use **/claim-watch remove** with address or label.`,
          flags: MessageFlags.Ephemeral,
        });
        debugLogActivity(interaction.guild?.name ?? interaction.guildId, interaction.user?.tag ?? "?", "/claim-watch list", `${list.length} tokens`);
      }
    } catch (e) {
      await interaction.reply({ content: `Claim watch failed: ${e.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  if (interaction.commandName === "claims-for-token") {
    const tokenInput = interaction.options.getString("token")?.trim();
    const match = tokenInput?.match(/0x[a-fA-F0-9]{40}/i);
    const addr = tokenInput && /^0x[a-fA-F0-9]{40}$/i.test(tokenInput)
      ? tokenInput.toLowerCase()
      : match ? match[0].toLowerCase() : null;
    if (!addr || !addr.endsWith("ba3")) {
      await interaction.reply({
        content: "Invalid token. Use a Bankr token address (0x…ba3) or a Bankr launch URL.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      let claims = await getTokenClaims(addr);
      if (claims.length === 0) {
        const tenant = interaction.guildId ? await getTenant(interaction.guildId) : null;
        const out = await getTokenFees(addr, { bankrApiKey: tenant?.bankrApiKey ?? process.env.BANKR_API_KEY });
        const feeWallet = out.feeWallet;
        if (feeWallet && process.env.CHAIN_ID === "8453") {
          const { getClaimTxsFromBaseScan } = await import("./basescan-claims.js");
          const { count, latestTxHash } = await getClaimTxsFromBaseScan(feeWallet, undefined, { limit: 50 });
          if (count > 0 && latestTxHash) {
            await interaction.editReply({
              content: `No claims found via RPC for \`${addr}\`.\n**BaseScan:** Fee recipient has **${count}** claim tx(s). Latest: https://basescan.org/tx/${latestTxHash}`,
            });
            return;
          }
        }
        await interaction.editReply({ content: `No claims found for \`${addr}\` (RPC getLogs). Fee recipient may not have claimed yet.` });
        return;
      }
      const lines = claims.map((c) => `• \`${c.beneficiary}\` · ${c.wethAmount} WETH · [TX](https://basescan.org/tx/${c.txHash})`);
      await interaction.editReply({
        content: `**Claims for** \`${addr}\` (${claims.length}):\n\n${lines.join("\n")}\n\n[Bankr](https://bankr.bot/launches/${addr})`,
      });
    } catch (e) {
      await interaction.editReply({ content: `Failed: ${e.message}` }).catch(() => {});
    }
    return;
  }

  if (interaction.commandName === "claims-for-wallet") {
    const wallet = interaction.options.getString("wallet")?.trim();
    const addr = wallet && /^0x[a-fA-F0-9]{40}$/.test(wallet) ? wallet.toLowerCase() : null;
    if (!addr) {
      await interaction.reply({ content: "Invalid wallet. Use 0x followed by 40 hex characters.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const claims = await getWalletClaims(addr);
      if (claims.length === 0) {
        await interaction.editReply({ content: `No Bankr fee claims found for \`${addr}\`.` });
        return;
      }
      const lines = claims.map((c) => {
        const sym = c.poolSymbol ? `$${c.poolSymbol}` : "";
        const bankr = `https://bankr.bot/launches/${c.tokenAddress}`;
        const tx = `https://basescan.org/tx/${c.txHash}`;
        return `${sym ? sym + " " : ""}\`${c.tokenAddress}\` · ${c.wethAmount} WETH · [Bankr](${bankr}) · [TX](${tx})`;
      });
      await interaction.editReply({
        content: `**Bankr claims for** \`${addr}\` (${claims.length}):\n\n${lines.join("\n")}`,
      });
    } catch (e) {
      await interaction.editReply({ content: `Failed to fetch claims: ${e.message}` }).catch(() => {});
    }
    return;
  }

  if (interaction.commandName === "claim-channel") {
    const guildId = interaction.guildId ?? null;
    const tenant = guildId ? await getTenant(guildId) : null;
    if (!guildId || !tenant) {
      await interaction.reply({
        content: "Run **/setup** first, then use **/claim-channel add** with a token address and channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!canManageServer(interaction)) {
      await interaction.reply({
        content: "Only server admins (Manage Server) can add or remove claim-channel mappings.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const sub = interaction.options.getSubcommand();
    try {
      if (sub === "add") {
        const token = interaction.options.getString("token")?.trim();
        const channel = interaction.options.getChannel("channel");
        const addr = token && /^0x[a-fA-F0-9]{40}$/.test(token) ? token.toLowerCase() : null;
        if (!addr || !addr.endsWith("ba3")) {
          await interaction.reply({ content: "Invalid token. Use a Bankr token address (0x...ba3).", flags: MessageFlags.Ephemeral });
          return;
        }
        if (!channel) {
          await interaction.reply({ content: "Please choose a channel.", flags: MessageFlags.Ephemeral });
          return;
        }
        await addClaimTokenChannel(guildId, addr, channel.id);
        await interaction.reply({
          content: `When **\`${addr}\`** is claimed, alerts will post to ${channel}. Use **/claim-channel list** or **remove** to change.`,
          flags: MessageFlags.Ephemeral,
        });
      } else if (sub === "remove") {
        const token = interaction.options.getString("token")?.trim();
        const addr = token && /^0x[a-fA-F0-9]{40}$/.test(token) ? token.toLowerCase() : null;
        const ok = addr ? await removeClaimTokenChannel(guildId, addr) : false;
        await interaction.reply({
          content: ok ? `Stopped sending claim alerts for \`${addr}\` to a channel.` : "Token not found. Use the exact address from **/claim-channel list**.",
          flags: MessageFlags.Ephemeral,
        });
      } else if (sub === "list") {
        const map = await getClaimTokenChannels(guildId);
        const entries = Object.entries(map);
        if (entries.length === 0) {
          await interaction.reply({
            content: "No token → channel mappings. Use **/claim-channel add** with a token (0x...ba3) and a channel.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const lines = entries.map(([t, cid]) => `• \`${t}\` → <#${cid}>`);
        await interaction.reply({
          content: `**Claim-channel** (${entries.length}):\n\n${lines.join("\n")}\n\nUse **/claim-channel remove** with the token address to stop.`,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (e) {
      await interaction.reply({ content: `Claim-channel failed: ${e.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  if (interaction.commandName !== "watch") return;

  const sub = interaction.options.getSubcommand();
  const type = interaction.options.getString("type");
  const value = interaction.options.getString("value");
  const name = interaction.options.getString("name");
  const guildId = interaction.guildId ?? null;
  const useTenant = guildId && (await getTenant(guildId));

  if ((sub === "add" || sub === "remove") && guildId && !canManageServer(interaction)) {
    await interaction.reply({
      content: "Only server admins (Manage Server permission) can **add** or **remove** watch list entries. Use **/watch list** to view.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    if (sub === "add") {
      if (type === "x" || type === "fc") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const normalized = value ? String(value).trim().toLowerCase().replace(/^@/, "") : "";
        if (useTenant) {
          const added = await updateWatchListForGuild(guildId, type, value, true, name ?? undefined);
          const label = name ? `${name} (${type === "x" ? "@" : ""}${normalized || value})` : `${type === "x" ? "@" : ""}${normalized || value}`;
          await interaction.editReply({
            content: added
              ? `Added **${label}** to this server's watch list.`
              : `**${label}** is already on the watch list.`,
          });
        } else {
          const tenant = guildId ? await getTenant(guildId) : null;
          const { wallet, normalized: norm } = await resolveHandleToWallet(value, { bankrApiKey: tenant?.bankrApiKey });
          if (!wallet) {
            await interaction.editReply({
              content: `Could not resolve **${type === "x" ? "@" : ""}${value}** to a wallet. Add a wallet address (0x...) directly with type **wallet**. Run **/setup** to use a per-server watchlist.`,
            });
            return;
          }
          const added = await addWallet(wallet);
          await interaction.editReply({
            content: added
              ? `Added **${type === "x" ? "@" : ""}${norm || value}** (wallet \`${wallet}\`) to watch list. Run **/setup** to use a per-server watchlist.`
              : `**${type === "x" ? "@" : ""}${norm || value}** is already on the watch list (wallet \`${wallet}\`).`,
          });
        }
      } else if (type === "wallet") {
        const addr = typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value.trim()) ? value.trim().toLowerCase() : null;
        if (useTenant) {
          const added = addr ? await updateWatchListForGuild(guildId, "wallet", addr, true, name ?? undefined) : false;
          const label = name ? `${name} (\`${addr}\`)` : `\`${addr}\``;
          await interaction.reply({
            content: addr
              ? (added ? `Added wallet ${label} to this server's watch list.` : `That wallet is already on the watch list.`)
              : "Invalid wallet address (use 0x + 40 hex chars).",
            flags: MessageFlags.Ephemeral,
          });
        } else {
          const added = await addWallet(value);
          await interaction.reply({
            content: added
              ? `Added wallet \`${String(value).trim().toLowerCase()}\` to watch list. Run **/setup** for per-server watchlist.`
              : (addr ? "That wallet is already on the watch list." : "Invalid wallet address (use 0x + 40 hex chars)."),
            flags: MessageFlags.Ephemeral,
          });
        }
      } else {
        if (useTenant) {
          const added = await updateWatchListForGuild(guildId, "keywords", value, true, name ?? undefined);
          const label = name ? `${name} ("${value}")` : `"${value}"`;
          await interaction.reply({
            content: added ? `Added keyword **${label}** to this server's watch list.` : `**${label}** is already on the watch list.`,
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await addKeyword(value);
          await interaction.reply({ content: `Added keyword **"${value}"** to watch list. Run **/setup** for per-server watchlist.`, flags: MessageFlags.Ephemeral });
        }
      }
    } else if (sub === "remove") {
      if (type === "x" || type === "fc") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (useTenant) {
          const ok = await updateWatchListForGuild(guildId, type, value, false);
          await interaction.editReply({
            content: ok ? `Removed **${type === "x" ? "@" : ""}${value}** from this server's watch list.` : "That handle was not on the watch list.",
          });
        } else {
          const tenant = guildId ? await getTenant(guildId) : null;
          const { wallet, normalized: norm } = await resolveHandleToWallet(value, { bankrApiKey: tenant?.bankrApiKey });
          if (!wallet) {
            await interaction.editReply({
              content: `Could not resolve **${type === "x" ? "@" : ""}${value}** to a wallet. If you added by wallet, remove with type **wallet** and the address.`,
            });
            return;
          }
          const ok = await removeWallet(wallet);
          await interaction.editReply({
            content: ok ? `Removed **${type === "x" ? "@" : ""}${norm || value}** (wallet) from watch list.` : "That wallet was not on the watch list.",
          });
        }
      } else if (type === "wallet") {
        if (useTenant) {
          const ok = await updateWatchListForGuild(guildId, "wallet", value, false);
          await interaction.reply({
            content: ok ? "Removed wallet from this server's watch list." : "Wallet not found or invalid address.",
            flags: MessageFlags.Ephemeral,
          });
        } else {
          const ok = await removeWallet(value);
          await interaction.reply({
            content: ok ? "Removed wallet from watch list." : "Wallet not found or invalid address.",
            flags: MessageFlags.Ephemeral,
          });
        }
      } else {
        if (useTenant) {
          const ok = await updateWatchListForGuild(guildId, "keywords", value, false);
          await interaction.reply({
            content: ok ? `Removed keyword **"${value}"** from this server's watch list.` : "Keyword not found.",
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await removeKeyword(value);
          await interaction.reply({ content: `Removed keyword **"${value}"** from watch list.`, flags: MessageFlags.Ephemeral });
        }
      }
    } else if (sub === "edit") {
      if (!useTenant) {
        await interaction.reply({
          content: "Use **/setup** to configure a per-server watchlist first. Editing is only available for server watch lists.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const editName = interaction.options.getString("name");
      const normalizedVal = type === "wallet" && value && /^0x[a-fA-F0-9]{40}$/.test(value.trim())
        ? value.trim().toLowerCase()
        : (value ? String(value).trim().toLowerCase().replace(/^@/, "") : "");
      const ok = await updateWatchListEntryName(guildId, type, normalizedVal || value, editName ?? null);
      const label = type === "x" ? `@${normalizedVal || value}` : type === "wallet" ? `\`${normalizedVal || value}\`` : normalizedVal || value;
      if (ok) {
        const nameStr = editName != null && String(editName).trim() ? String(editName).trim() : null;
        await interaction.reply({
          content: nameStr
            ? `Updated **${label}** → nickname set to **${nameStr}**.`
            : `Cleared nickname for **${label}**.`,
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: `**${label}** was not found on this server's watch list. Use **/watch list** to see entries.`,
          flags: MessageFlags.Ephemeral,
        });
      }
    } else if (sub === "list") {
      if (useTenant) {
        const wl = await getWatchListDisplayForGuild(guildId);
        const fmtX = (arr) => (arr.length ? arr.map((e) => (e.name ? `${e.name} (@${e.value})` : `@${e.value}`)).join(", ") : "_none_");
        const fmtFc = (arr) => (arr.length ? arr.map((e) => (e.name ? `${e.name} (${e.value})` : e.value)).join(", ") : "_none_");
        const fmtWallet = (arr) => (arr.length ? arr.map((e) => (e.name ? `${e.name} (\`${e.value}\`)` : `\`${e.value}\``)).join(", ") : "_none_");
        const fmtKw = (arr) => (arr.length ? arr.map((e) => (e.name ? `${e.name} ("${e.value}")` : `"${e.value}"`)).join(", ") : "_none_");
        const lines = [
          "**Watch list** (this server)",
          "**X:** " + fmtX(wl.x),
          "**Farcaster:** " + fmtFc(wl.fc),
          "**Wallets:** " + fmtWallet(wl.wallet),
          "**Keywords:** " + fmtKw(wl.keywords),
        ];
        await interaction.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
        debugLogActivity(interaction.guild?.name ?? interaction.guildId, interaction.user?.tag ?? "?", "/watch list", "");
      } else {
        const { wallet, keywords } = await list();
        const walletBlock = wallet.length ? wallet.map((w) => `\`${w}\``).join("\n") : "_none_";
        const kwStr = keywords.length ? keywords.map((k) => `"${k}"`).join(", ") : "_none_";
        await interaction.reply({
          content: `**Watch list** (global)\n\n**Wallets:**\n${walletBlock}\n\n**Keywords:** ${kwStr}\n\nRun **/setup** to use a per-server watchlist.`,
          flags: MessageFlags.Ephemeral,
        });
        debugLogActivity(interaction.guild?.name ?? interaction.guildId, interaction.user?.tag ?? "?", "/watch list", "global");
      }
    }
  } catch (e) {
    console.error("Watch command failed:", e.message);
    debugLogError(e, "watch");
    await interaction.reply({ content: `Error: ${e.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

if (DEBUG_WEBHOOK_URL) {
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
    debugLogError(err, "uncaughtException");
  });
  process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled rejection:", reason);
    debugLogError(reason instanceof Error ? reason : new Error(String(reason)), "unhandledRejection");
  });
}

client.login(TOKEN);
