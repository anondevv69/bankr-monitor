#!/usr/bin/env node
import "dotenv/config";
/**
 * Discord bot with /watch commands to manage the Bankr launch watch list.
 * Add/remove X, Farcaster, wallet, keyword watchers. Runs the notify loop in the background.
 * Launch alerts are posted by the bot to DISCORD_ALERT_CHANNEL_ID or DISCORD_WATCH_ALERT_CHANNEL_ID (not webhook).
 *
 * Env: DISCORD_BOT_TOKEN (required)
 *   DISCORD_ALERT_CHANNEL_ID    - channel for all launch alerts (fallback)
 *   DISCORD_WATCH_ALERT_CHANNEL_ID - channel for watch-list matches (wallet/X/FC/keyword); use this to separate watch alerts from webhook deployments
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
  updateWatchListForGuild,
  getClaimWatchTokens,
  addClaimWatchToken,
  removeClaimWatchToken,
  getTenantStats,
} from "./tenant-store.js";
import { runNotifyCycle, buildLaunchEmbed, buildTokenDetailEmbed, sendTelegram } from "./notify.js";
import { lookupByDeployerOrFee, resolveHandleToWallet } from "./lookup-deployer.js";
import { buildDeployBody, callBankrDeploy } from "./deploy-token.js";
import { getTokenFees } from "./token-stats.js";
import { getFeesSummaryOnChainOnly } from "./fees-for-wallet.js";
import { getClaimState, setClaimState } from "./claim-watch-store.js";
import { getNewAgentProfiles } from "./agent-profiles.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const ALERT_CHANNEL_ID = process.env.DISCORD_ALERT_CHANNEL_ID;
const WATCH_ALERT_CHANNEL_ID = process.env.DISCORD_WATCH_ALERT_CHANNEL_ID;
const DEBUG_WEBHOOK_URL = process.env.DISCORD_DEBUG_WEBHOOK_URL;
const INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || "60000", 10);
const LOOKUP_PAGE_SIZE = Math.min(Math.max(parseInt(process.env.LOOKUP_PAGE_SIZE || "5", 10), 3), 25);
const LOOKUP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const lookupCache = new Map(); // messageId -> { matches, query, by, searchUrl, totalCount, possiblyCapped, createdAt }

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
      )
      .addSubcommand((s) =>
        s
          .setName("remove")
          .setDescription("Remove a token from the claim watch list")
          .addStringOption((o) =>
            o.setName("token_address").setDescription("Token address to stop watching").setRequired(true)
          )
      )
      .toJSON(),
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
          .setName("alert_channel")
          .setDescription("Channel for all new token launch alerts")
          .setRequired(true)
      )
      .addChannelOption((o) =>
        o
          .setName("watch_channel")
          .setDescription("Channel for watch-list matches only (optional)")
          .setRequired(false)
      )
      .addChannelOption((o) =>
        o
          .setName("agent_channel")
          .setDescription("Channel for new Bankr agent profile alerts (optional)")
          .setRequired(false)
      )
      .addBooleanOption((o) =>
        o
          .setName("filter_x_match")
          .setDescription("Only alert when deployer and fee recipient share same X/FC (default: false)")
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
            o.setName("alert_channel").setDescription("Channel for all launch alerts").setRequired(false)
          )
          .addChannelOption((o) =>
            o.setName("watch_channel").setDescription("Channel for watch-list matches").setRequired(false)
          )
          .addChannelOption((o) =>
            o.setName("agent_channel").setDescription("Channel for new agent profile alerts").setRequired(false)
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
      .setDescription("Show how to use BankrMonitor (watch, lookup, wallet lookup, deploy)")
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

async function runNotify() {
  const hasEnvChannels = ALERT_CHANNEL_ID || WATCH_ALERT_CHANNEL_ID;
  if (hasEnvChannels) {
    try {
      const { newLaunches } = await runNotifyCycle();
      const alertChannel = ALERT_CHANNEL_ID ? await client.channels.fetch(ALERT_CHANNEL_ID).catch(() => null) : null;
      const watchChannel = WATCH_ALERT_CHANNEL_ID ? await client.channels.fetch(WATCH_ALERT_CHANNEL_ID).catch(() => null) : null;

      for (const launch of newLaunches) {
        const embed = buildLaunchEmbed(launch);
        const showInAlert = launch.passedFilters !== false;
        const showInWatch = launch.isWatchMatch;
        const sameChannel = alertChannel && watchChannel && alertChannel.id === watchChannel.id;
        if (sameChannel) {
          if ((showInAlert || showInWatch) && alertChannel) {
            try {
              await alertChannel.send({ embeds: [embed] });
            } catch (e) {
              console.error(`Alert/Watch channel failed:`, e.message);
            }
          }
        } else {
          if (alertChannel && showInAlert) {
            try {
              await alertChannel.send({ embeds: [embed] });
            } catch (e) {
              console.error(`Alert channel ${ALERT_CHANNEL_ID} failed:`, e.message);
            }
          }
          if (watchChannel && showInWatch) {
            try {
              await watchChannel.send({ embeds: [embed] });
            } catch (e) {
              console.error(`Watch channel ${WATCH_ALERT_CHANNEL_ID} failed:`, e.message, "- Check bot has Send Messages + Embed Links in that channel.");
            }
          }
        }
        await sendTelegram(launch);
      }
    } catch (e) {
      console.error("Notify failed:", e.message);
    }
  } else {
    const guildIds = await listActiveTenantGuildIds();
    const tenantsWithChannels = [];
    for (const gid of guildIds) {
      const t = await getTenant(gid);
      if (t && (t.alertChannelId || t.watchAlertChannelId)) tenantsWithChannels.push({ guildId: gid, ...t });
    }
    if (tenantsWithChannels.length > 0) {
      try {
        const firstApiKey = tenantsWithChannels[0]?.bankrApiKey ?? process.env.BANKR_API_KEY;
        const { newLaunches } = await runNotifyCycle({ bankrApiKey: firstApiKey });
        for (const launch of newLaunches) {
          const embed = buildLaunchEmbed(launch);
          for (const tenant of tenantsWithChannels) {
            const showInAlert = tenantPassesFilters(launch, tenant.rules);
            const watchList = await getWatchListForGuild(tenant.guildId);
            const showInWatch = isWatchMatchForTenant(launch, watchList);
            const alertCh = tenant.alertChannelId ? await client.channels.fetch(tenant.alertChannelId).catch(() => null) : null;
            const watchCh = tenant.watchAlertChannelId ? await client.channels.fetch(tenant.watchAlertChannelId).catch(() => null) : null;
            if (alertCh && showInAlert) await alertCh.send({ embeds: [embed] }).catch(() => {});
            if (watchCh && showInWatch && watchCh?.id !== alertCh?.id) await watchCh.send({ embeds: [embed] }).catch(() => {});
            if (tenant.telegramChatId && (showInAlert || showInWatch)) await sendTelegram(launch, { chatId: tenant.telegramChatId }).catch(() => {});
          }
        }
      } catch (e) {
        console.error("Notify failed:", e.message);
        debugLogError(e, "runNotify (tenant channels)");
      }
    } else {
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [join(__dirname, "notify.js")],
          { stdio: "inherit", env: process.env }
        );
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      });
    }
  }
  await runClaimWatchCycle().catch((e) => {
    console.error("Claim watch cycle failed:", e.message);
    debugLogError(e, "runClaimWatchCycle");
  });
  await runAgentProfilesCycle().catch((e) => {
    console.error("Agent profiles cycle failed:", e.message);
    debugLogError(e, "runAgentProfilesCycle");
  });
}

/** Build a Discord embed for a new Bankr Agent Profile. */
function buildAgentProfileEmbed(profile) {
  const slug = profile.slug || profile.id || "";
  const url = slug ? `https://bankr.bot/agent-profiles/${encodeURIComponent(slug)}` : "https://bankr.bot/agents";
  const title = profile.projectName || "New Agent";
  const symbol = profile.tokenSymbol ? ` ($${profile.tokenSymbol})` : "";
  const embed = {
    title: `🆕 New Agent Profile · ${title}${symbol}`,
    url,
    color: 0x5865f2,
    description: profile.description ? String(profile.description).slice(0, 500) : null,
    fields: [],
    footer: { text: "Bankr Agent Profiles · bankr.bot/agents" },
    timestamp: profile.createdAt ? new Date(profile.createdAt).toISOString() : undefined,
  };
  if (profile.marketCapUsd != null && profile.marketCapUsd > 0) {
    const fmt = profile.marketCapUsd >= 1e6 ? `${(profile.marketCapUsd / 1e6).toFixed(2)}M` : profile.marketCapUsd >= 1e3 ? `${(profile.marketCapUsd / 1e3).toFixed(2)}K` : String(profile.marketCapUsd);
    embed.fields.push({ name: "Market cap", value: `$${fmt}`, inline: true });
  }
  if (profile.weeklyRevenueWeth != null && profile.weeklyRevenueWeth !== "" && Number(profile.weeklyRevenueWeth) > 0) {
    embed.fields.push({ name: "Weekly revenue (WETH)", value: String(profile.weeklyRevenueWeth), inline: true });
  }
  if (profile.tokenAddress) {
    embed.fields.push({ name: "Token", value: `\`${profile.tokenAddress}\``, inline: false });
  }
  embed.fields.push({ name: "View", value: `[Open on Bankr](${url})`, inline: false });
  return embed;
}

async function runAgentProfilesCycle() {
  const newProfiles = await getNewAgentProfiles({ limit: 30 });
  if (newProfiles.length === 0) return;
  const hasEnvChannels = ALERT_CHANNEL_ID || WATCH_ALERT_CHANNEL_ID;
  if (hasEnvChannels) {
    const alertChannel = ALERT_CHANNEL_ID ? await client.channels.fetch(ALERT_CHANNEL_ID).catch(() => null) : null;
    for (const profile of newProfiles) {
      const embed = buildAgentProfileEmbed(profile);
      if (alertChannel) await alertChannel.send({ embeds: [embed] }).catch((e) => console.error("Agent profile alert failed:", e.message));
    }
  } else {
    const guildIds = await listActiveTenantGuildIds();
    for (const gid of guildIds) {
      const tenant = await getTenant(gid);
      const channelId = tenant?.agentAlertChannelId || tenant?.alertChannelId || tenant?.watchAlertChannelId;
      if (!channelId) continue;
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel) continue;
      for (const profile of newProfiles) {
        const embed = buildAgentProfileEmbed(profile);
        await channel.send({ embeds: [embed] }).catch(() => {});
      }
    }
  }
}

const CLAIM_WATCH_DECIMALS = 18;
const CLAIM_DROP_TOLERANCE = 1e-12;

async function runClaimWatchCycle() {
  const guildIds = await listActiveTenantGuildIds();
  for (const guildId of guildIds) {
    const tenant = await getTenant(guildId);
    const tokens = await getClaimWatchTokens(guildId);
    if (tokens.length === 0) continue;
    const channelId = tenant?.watchAlertChannelId || tenant?.alertChannelId;
    if (!channelId) continue;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) continue;

    for (const tokenAddress of tokens) {
      try {
        const out = await getTokenFees(tokenAddress, { bankrApiKey: tenant?.bankrApiKey ?? process.env.BANKR_API_KEY });
        const hookFees = out.hookFees;
        const currentToken = hookFees ? Number(hookFees.beneficiaryFees0) / 10 ** CLAIM_WATCH_DECIMALS : 0;
        const currentWeth = hookFees ? Number(hookFees.beneficiaryFees1) / 10 ** CLAIM_WATCH_DECIMALS : 0;
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
          const lines = [];
          if (tokenDropped) lines.push(`Token: ${prev.lastClaimableToken.toFixed(6)} → ${currentToken.toFixed(6)}`);
          if (wethDropped) lines.push(`WETH: ${prev.lastClaimableWeth.toFixed(6)} → ${currentWeth.toFixed(6)}`);
          const embed = {
            color: 0x00_80_00,
            title: "Fees claimed",
            description: `**${name}** ($${symbol})\n\`${tokenAddress}\`\n\n${lines.join("\n")}\n\n[View on Bankr](https://bankr.bot/launches/${tokenAddress})`,
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

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands(client.application.id);
  if (WATCH_ALERT_CHANNEL_ID) {
    console.log(`Watch-list alerts will post to channel ${WATCH_ALERT_CHANNEL_ID}`);
  }
  if (ALERT_CHANNEL_ID) {
    console.log(`Launch alerts will post to channel ${ALERT_CHANNEL_ID}`);
  }
  if (!ALERT_CHANNEL_ID && !WATCH_ALERT_CHANNEL_ID) {
    console.log("DISCORD_ALERT_CHANNEL_ID and DISCORD_WATCH_ALERT_CHANNEL_ID not set; alerts go to each server's /setup channels or notify.js webhook.");
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
        const tokenAmt = Number(h.beneficiaryFees0) / 10 ** DECIMALS;
        const wethAmt = Number(h.beneficiaryFees1) / 10 ** DECIMALS;
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

function formatFeesTokenReply(out, tokenAddress) {
  const { name, symbol, feeWallet, feeRecipient, cumulatedFees, hookFees, estimatedCreatorFeesUsd, formatUsd: fmt, error } = out;
  const launchUrl = `https://bankr.bot/launches/${tokenAddress}`;
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

  // Claimable right now — pool order: token0 = WETH, token1 = asset
  const hasHookData = hookFees != null;
  const claimableWeth = hasHookData ? Number(hookFees.beneficiaryFees0) / 10 ** DECIMALS : null;
  const claimableToken = hasHookData ? Number(hookFees.beneficiaryFees1) / 10 ** DECIMALS : null;

  if (hasHookData) {
    const oneLiner = formatClaimableOneLiner(hookFees, symbol);
    if (oneLiner) {
      lines.push(`**Claimable:** ${oneLiner}`);
      lines.push("");
    }
    lines.push("**Claimable right now** (on-chain `getHookFees`) — what the recipient can claim:");
    if (hookFees.beneficiaryFees0 > 0n || hookFees.beneficiaryFees1 > 0n) {
      if (hookFees.beneficiaryFees0 > 0n) lines.push(`• WETH: ${claimableWeth.toFixed(4)}`);
      if (hookFees.beneficiaryFees1 > 0n) {
        const n = claimableToken;
        const tokStr = n >= 1e9 ? `${(n / 1e9).toFixed(0)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(0)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(4);
        lines.push(`• Token: ${tokStr}`);
      }
    } else {
      lines.push("• No unclaimed fees yet.");
    }
    lines.push("");
  }

  // Historical accrued (indexer): indexer uses token0 = WETH, token1 = asset (token)
  const hasIndexerFees = cumulatedFees && (cumulatedFees.token0Fees != null || cumulatedFees.token1Fees != null || cumulatedFees.totalFeesUsd != null);
  if (hasIndexerFees) {
    const raw0 = cumulatedFees.token0Fees != null ? BigInt(cumulatedFees.token0Fees) : 0n;
    const raw1 = cumulatedFees.token1Fees != null ? BigInt(cumulatedFees.token1Fees) : 0n;
    const accruedWeth = Number(raw0) / 10 ** DECIMALS;
    const accruedToken = Number(raw1) / 10 ** DECIMALS;
    function fmtTokenAmount(n) {
      if (n >= 1e9) return `${(n / 1e9).toFixed(0)}B`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
      return n.toFixed(4);
    }
    lines.push("**Historical accrued** (indexer) — all-time fees for this beneficiary:");
    if (cumulatedFees.token0Fees != null) lines.push(`• WETH: ${accruedWeth.toFixed(4)}`);
    if (cumulatedFees.token1Fees != null) lines.push(`• Token (${symbol}): ${fmtTokenAmount(accruedToken)}`);
    const totalUsd = cumulatedFees.totalFeesUsd != null ? Number(cumulatedFees.totalFeesUsd) : NaN;
    if (cumulatedFees.totalFeesUsd != null && !Number.isNaN(totalUsd) && totalUsd < 1e9 && totalUsd >= 0) {
      lines.push(`• **Total (USD):** ${fmt(cumulatedFees.totalFeesUsd) ?? cumulatedFees.totalFeesUsd}`);
    }
    if (hasHookData) {
      const claimableT = claimableToken ?? 0;
      const claimableW = claimableWeth ?? 0;
      const claimedT = Math.max(0, accruedToken - claimableT);
      const claimedW = Math.max(0, accruedWeth - claimableW);
      if (claimedT > 0 || claimedW > 0) {
        lines.push("**Already claimed** ≈ Accrued − Claimable:");
        if (claimedT > 0) lines.push(`• Token: ${fmtTokenAmount(claimedT)}`);
        if (claimedW > 0) lines.push(`• WETH: ${claimedW.toFixed(4)}`);
        lines.push("_Some fees have been claimed for this token._");
      } else {
        lines.push("_None claimed yet (claimable = accrued)._");
      }
    } else {
      lines.push("_Claimable (on-chain) not available — cannot tell if any fees have been claimed. Set **RPC_URL_BASE** or **RPC_URL** (Base RPC) in the bot env to enable._");
    }
    lines.push("");
  }

  if (hasHookData || hasIndexerFees) {
    const retrievedAt = new Date().toLocaleString("en-US", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" });
    lines.push(`_Data retrieved: ${retrievedAt} UTC_`);
    lines.push("");
  }

  // Removed: estimated $0, "no volume", and RPC hint when we have historical or claimable data
  if (!hasHookData && !hasIndexerFees) {
    if (estimatedCreatorFeesUsd != null && estimatedCreatorFeesUsd > 0) {
      lines.push(`**Estimated** creator fees (57% of 1.2% of volume): ${fmt(estimatedCreatorFeesUsd) ?? "—"}`);
      lines.push("");
    }
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
        const claimedW = Math.max(0, w - cW);
        const claimedT = Math.max(0, t - cT);
        if (claimedW > 0 || claimedT > 0) {
          feeParts.push(`**Already claimed:** WETH ${claimedW.toFixed(4)} • Token ${fmtT(claimedT)}`);
        }
      }
    }
    if (out.hookFees && !claimableLine) {
      feeParts.push("**Claimable:** 0 WETH · 0 token (no unclaimed fees yet).");
    }
    if (feeParts.length > 0) {
      const retrievedAt = new Date().toLocaleString("en-US", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" });
      feeParts.push(`_Data retrieved: ${retrievedAt} UTC_`);
    } else if (out.launch) {
      if (out.estimatedCreatorFeesUsd != null && out.estimatedCreatorFeesUsd > 0 && out.formatUsd) {
        feeParts.push(`**Estimated** creator fees (57% of 1.2% of volume): ${out.formatUsd(out.estimatedCreatorFeesUsd) ?? "—"}`);
      }
      const rpcSet = !!(process.env.RPC_URL_BASE || process.env.RPC_URLBASE || process.env.RPC_URL);
      if (rpcSet && !out.hasPoolIdForHook) {
        feeParts.push("_RPC is set; this token's **pool ID** (bytes32) wasn't found in the Bankr API or indexer — claimable fees need it. It may appear after the pool is indexed._");
      } else if (!rpcSet) {
        feeParts.push("_No fee data yet — set **RPC_URL_BASE** or **RPC_URL** (Base RPC) in the bot env for on-chain claimable._");
      } else {
        feeParts.push("_No fee data yet for this pool (indexer or on-chain)._");
      }
      const retrievedAt = new Date().toLocaleString("en-US", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" });
      feeParts.push(`_Data retrieved: ${retrievedAt} UTC_`);
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
      await interaction.reply({ content: "This lookup has expired. Run /lookup again.", flags: MessageFlags.Ephemeral }).catch(() => {});
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
        "This bot helps you **watch** Bankr launches, **look up** tokens by wallet/X/Farcaster, and **deploy** Bankr tokens. Data: Bankr API.",
      fields: [
        {
          name: "📋 /watch",
          value:
            "**add** – Add to watch list (type: X, Farcaster, wallet, or keyword + value). X and Farcaster are resolved to wallet first, then that wallet is added. New launches matching them are posted to the watch channel.\n" +
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
        {
          name: "🚀 /deploy",
          value:
            "**Deploy a Bankr token** from Discord.\n" +
            "**name** (required), **symbol**, **description**, **image_url**, **website_url**, **tweet_url**.\n" +
            "**Fee recipient:** wallet (0x…), X handle, Farcaster handle, or ENS — set type + value to send 57% creator fees there. Otherwise fees go to the API key wallet.\n" +
            "**simulate_only:** dry run. Requires **BANKR_API_KEY** with Agent API (write) access at [bankr.bot/api](https://bankr.bot/api). Rate limit: 50 deploys/24h.",
          inline: false,
        },
        {
          name: "💰 /fees-token",
          value:
            "**Accrued/claimable fees** for one Bankr token.\n" +
            "**token:** Token address (0x…) or Bankr launch URL (e.g. bankr.bot/launches/0x…). Shows fee recipient, indexer accrued fees (token + WETH + USD) when available, or estimated from volume. Claimed vs unclaimed is not in the API — use [Bankr terminal](https://bankr.bot/terminal) or `bankr fees --token <ca>` to see/claim.",
          inline: false,
        },
        {
          name: "📌 Channels & paste",
          value:
            "**Alert channel** – all new Bankr launches.\n**Watch channel** – only launches that match your watch list.\n" +
            "**Paste a Bankr token** (any channel): if someone pastes a token address ending in **BA3**, the bot replies with name, symbol, link, and what it knows (volume, fees).",
          inline: false,
        },
      ],
      footer: { text: "Bankr: bankr.bot" },
    };
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  if (interaction.commandName === "deploy") {
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
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const tenant = interaction.guildId ? await getTenant(interaction.guildId) : null;
      const out = await getTokenFees(tokenAddress, { bankrApiKey: tenant?.bankrApiKey ?? process.env.BANKR_API_KEY });
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
      const alertChannel = interaction.options.getChannel("alert_channel");
      const watchChannel = interaction.options.getChannel("watch_channel");
      const agentChannel = interaction.options.getChannel("agent_channel");
      const filterXMatch = interaction.options.getBoolean("filter_x_match") ?? false;
      const filterMaxDeploys = interaction.options.getInteger("filter_max_deploys");
      const pollIntervalMin = interaction.options.getNumber("poll_interval_min");
      if (!apiKey || !alertChannel) {
        await interaction.editReply({
          content: "Provide **api_key** and **alert_channel**. Get a key at [bankr.bot/api](https://bankr.bot/api).",
        });
        return;
      }
      const updates = {
        bankrApiKey: apiKey,
        alertChannelId: alertChannel.id,
        watchAlertChannelId: watchChannel?.id ?? null,
        agentAlertChannelId: agentChannel?.id ?? null,
        rules: {
          filterXMatch,
          filterMaxDeploys: filterMaxDeploys != null ? filterMaxDeploys : null,
          pollIntervalMs: pollIntervalMin != null ? Math.max(0.5, pollIntervalMin) * 60_000 : 60_000,
        },
      };
      await setTenant(guildId, updates);
      const lines = [
        "**Server config saved.**",
        `• Alert channel: ${alertChannel.name}`,
        watchChannel ? `• Watch channel: ${watchChannel.name}` : "• Watch channel: (none)",
        agentChannel ? `• Agent alerts channel: ${agentChannel.name}` : "• Agent alerts channel: (none)",
        `• Filter X match: ${filterXMatch}`,
        filterMaxDeploys != null ? `• Max deploys/day: ${filterMaxDeploys}` : "",
        `• Poll interval: ${updates.rules.pollIntervalMs / 60_000} min`,
        "",
        "Use **/watch add** to add X, Farcaster, wallets, or keywords. Use **/settings show** to view or **/settings** subcommands to edit.",
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
          `• Alert channel: ${tenant.alertChannelId ? `<#${tenant.alertChannelId}>` : "—"}`,
          `• Watch channel: ${tenant.watchAlertChannelId ? `<#${tenant.watchAlertChannelId}>` : "—"}`,
          `• Agent alerts channel: ${tenant.agentAlertChannelId ? `<#${tenant.agentAlertChannelId}>` : "—"}`,
          `• Filter X match: ${tenant.rules?.filterXMatch ?? false}`,
          `• Max deploys/day: ${tenant.rules?.filterMaxDeploys ?? "—"}`,
          `• Poll interval: ${((tenant.rules?.pollIntervalMs ?? 60000) / 60_000)} min`,
          "• Watchlist: X " + (w.x?.length ?? 0) + ", FC " + (w.fc?.length ?? 0) + ", wallets " + (w.wallet?.length ?? 0) + ", keywords " + (w.keywords?.length ?? 0),
          "",
          "Use **/settings api_key**, **/settings channels**, or **/settings rules** to edit.",
        ];
        await interaction.editReply({ content: lines.join("\n") });
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
        const alertChannel = interaction.options.getChannel("alert_channel");
        const watchChannel = interaction.options.getChannel("watch_channel");
        const agentChannel = interaction.options.getChannel("agent_channel");
        const updates = {};
        if (alertChannel) updates.alertChannelId = alertChannel.id;
        if (watchChannel !== null) updates.watchAlertChannelId = watchChannel?.id ?? null;
        if (agentChannel !== null) updates.agentAlertChannelId = agentChannel?.id ?? null;
        if (Object.keys(updates).length === 0) {
          await interaction.editReply({ content: "Provide at least one channel to update." });
          return;
        }
        await setTenant(guildId, updates);
        await interaction.editReply({ content: "Channels updated." });
        return;
      }
      if (sub === "rules") {
        const filterXMatch = interaction.options.getBoolean("filter_x_match");
        const filterMaxDeploys = interaction.options.getInteger("filter_max_deploys");
        const pollIntervalMin = interaction.options.getNumber("poll_interval_min");
        const tenant = await getTenant(guildId);
        const rules = { ...(tenant?.rules ?? {}) };
        if (filterXMatch !== null) rules.filterXMatch = filterXMatch;
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

    if (!guildId || !tenant || (!tenant.alertChannelId && !tenant.watchAlertChannelId)) {
      await interaction.reply({
        content: "Claim watch is available per server. Run **/setup** first (API key + alert channel), then use **/claim-watch add** with a token address.",
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
        const addr = tokenAddress && /^0x[a-fA-F0-9]{40}$/.test(tokenAddress.trim()) ? tokenAddress.trim().toLowerCase() : null;
        if (!addr) {
          await interaction.reply({ content: "Invalid token address. Use 0x followed by 40 hex characters.", flags: MessageFlags.Ephemeral });
          return;
        }
        const added = await addClaimWatchToken(guildId, addr);
        await interaction.reply({
          content: added
            ? `Added \`${addr}\` to the claim watch list. You'll be notified in this server's watch/alert channel when its fees are claimed.`
            : "That token is already on the claim watch list.",
          flags: MessageFlags.Ephemeral,
        });
      } else if (sub === "remove") {
        const tokenAddress = interaction.options.getString("token_address");
        const ok = await removeClaimWatchToken(guildId, tokenAddress);
        await interaction.reply({
          content: ok ? "Removed that token from the claim watch list." : "Token not found or invalid address.",
          flags: MessageFlags.Ephemeral,
        });
      } else if (sub === "list") {
        const list = await getClaimWatchTokens(guildId);
        if (list.length === 0) {
          await interaction.reply({ content: "Claim watch list is empty. Use **/claim-watch add** with a token address.", flags: MessageFlags.Ephemeral });
          return;
        }
        const lines = list.map((a) => `• \`${a}\``);
        await interaction.reply({
          content: `**Claim watch list** (${list.length} token${list.length === 1 ? "" : "s"}):\n\n${lines.join("\n")}\n\nYou'll be notified when fees are claimed for any of these tokens.`,
          flags: MessageFlags.Ephemeral,
        });
        debugLogActivity(interaction.guild?.name ?? interaction.guildId, interaction.user?.tag ?? "?", "/claim-watch list", `${list.length} tokens`);
      }
    } catch (e) {
      await interaction.reply({ content: `Claim watch failed: ${e.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  if (interaction.commandName !== "watch") return;

  const sub = interaction.options.getSubcommand();
  const type = interaction.options.getString("type");
  const value = interaction.options.getString("value");
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
          const added = await updateWatchListForGuild(guildId, type, value, true);
          await interaction.editReply({
            content: added
              ? `Added **${type === "x" ? "@" : ""}${normalized || value}** to this server's watch list.`
              : `**${type === "x" ? "@" : ""}${normalized || value}** is already on the watch list.`,
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
          const added = addr ? await updateWatchListForGuild(guildId, "wallet", addr, true) : false;
          await interaction.reply({
            content: addr
              ? (added ? `Added wallet \`${addr}\` to this server's watch list.` : `That wallet is already on the watch list.`)
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
          const added = await updateWatchListForGuild(guildId, "keywords", value, true);
          await interaction.reply({
            content: added ? `Added keyword **"${value}"** to this server's watch list.` : `Keyword **"${value}"** is already on the watch list.`,
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
    } else if (sub === "list") {
      if (useTenant) {
        const wl = await getWatchListForGuild(guildId);
        const x = [...wl.x], fc = [...wl.fc], wallet = [...wl.wallet], keywords = [...wl.keywords];
        const lines = [
          "**Watch list** (this server)",
          "**X:** " + (x.length ? x.map((h) => `@${h}`).join(", ") : "_none_"),
          "**Farcaster:** " + (fc.length ? fc.join(", ") : "_none_"),
          "**Wallets:** " + (wallet.length ? wallet.map((w) => `\`${w}\``).join(", ") : "_none_"),
          "**Keywords:** " + (keywords.length ? keywords.map((k) => `"${k}"`).join(", ") : "_none_"),
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
