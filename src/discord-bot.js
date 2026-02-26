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
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { addWallet, removeWallet, addKeyword, removeKeyword, list } from "./watch-store.js";
import { runNotifyCycle, buildLaunchEmbed, sendTelegram } from "./notify.js";
import { lookupByDeployerOrFee, resolveHandleToWallet } from "./lookup-deployer.js";
import { buildDeployBody, callBankrDeploy } from "./deploy-token.js";
import { getTokenFees } from "./token-stats.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const ALERT_CHANNEL_ID = process.env.DISCORD_ALERT_CHANNEL_ID;
const WATCH_ALERT_CHANNEL_ID = process.env.DISCORD_WATCH_ALERT_CHANNEL_ID;
const INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || "60000", 10);
const LOOKUP_PAGE_SIZE = Math.min(Math.max(parseInt(process.env.LOOKUP_PAGE_SIZE || "5", 10), 3), 25);
const LOOKUP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const lookupCache = new Map(); // messageId -> { matches, query, by, searchUrl, totalCount, possiblyCapped, createdAt }
function buildLookupEmbed(data, page) {
  const { matches, query, by, searchUrl, totalCount, possiblyCapped, resolvedWallet } = data;
  const total = totalCount > 0 ? totalCount : matches.length;
  const byLabel = by === "deployer" ? " (deployer)" : by === "fee" ? " (fee recipient)" : "";
  const totalPages = Math.ceil(matches.length / LOOKUP_PAGE_SIZE) || 1;
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const start = currentPage * LOOKUP_PAGE_SIZE;
  const pageMatches = matches.slice(start, start + LOOKUP_PAGE_SIZE);
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
  const { matches } = data;
  const totalPages = Math.ceil(matches.length / LOOKUP_PAGE_SIZE) || 1;
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
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

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function registerCommands(appId) {
  const rest = new REST().setToken(TOKEN);
  const commands = [
    new SlashCommandBuilder()
      .setName("watch")
      .setDescription("Manage Bankr launch watch list")
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
      .addSubcommand((s) => s.setName("list").setDescription("Show current watch list"))
      .toJSON(),
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
      .setName("resolve")
      .setDescription("Get the wallet address for an X or Farcaster account")
      .addStringOption((o) =>
        o
          .setName("query")
          .setDescription("X handle (@user), Farcaster handle, or profile URL (e.g. x.com/gork)")
          .setRequired(true)
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
      .setName("help")
      .setDescription("Show how to use BankrMonitor (watch, lookup, resolve, deploy)")
      .toJSON(),
  ];

  try {
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log("Slash commands registered");
  } catch (e) {
    console.error("Failed to register commands:", e.message);
  }
}

async function runNotify() {
  const hasChannel = ALERT_CHANNEL_ID || WATCH_ALERT_CHANNEL_ID;
  if (hasChannel) {
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
    console.log("DISCORD_ALERT_CHANNEL_ID and DISCORD_WATCH_ALERT_CHANNEL_ID not set; falling back to webhook (notify.js)");
  }

  setInterval(() => {
    runNotify().catch((e) => console.error("Notify failed:", e.message));
  }, INTERVAL);
  runNotify().catch((e) => console.error("Notify failed:", e.message));
});

// Prune stale lookup cache entries
function pruneLookupCache() {
  const now = Date.now();
  for (const [id, entry] of lookupCache.entries()) {
    if (now - entry.createdAt > LOOKUP_CACHE_TTL_MS) lookupCache.delete(id);
  }
}

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

  if (interaction.commandName === "resolve") {
    const query = interaction.options.getString("query");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { wallet, normalized, isWallet } = await resolveHandleToWallet(query);
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
    } catch (e) {
      await interaction.editReply({ content: `Resolve failed: ${e.message}` }).catch(() => {});
    }
    return;
  }

  if (interaction.commandName === "lookup") {
    const query = interaction.options.getString("query");
    const by = interaction.options.getString("by") || "both";
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { matches, totalCount, normalized, possiblyCapped, resolvedWallet } = await lookupByDeployerOrFee(query, by);
      const searchQ = normalized || String(query).trim();
      const searchUrl = resolvedWallet
        ? `https://bankr.bot/launches/search?q=${encodeURIComponent(resolvedWallet)}`
        : `https://bankr.bot/launches/search?q=${encodeURIComponent(searchQ)}`;
      if (matches.length === 0) {
        const looksLikeHandle = !/^0x[a-fA-F0-9]{40}$/.test(String(searchQ).trim());
        await interaction.editReply({
          content:
            `No Bankr tokens found for **${searchQ}**.\nFull search: ${searchUrl}` +
            (looksLikeHandle ? "\n\nTry **/resolve** with the same handle to get the wallet, then **/lookup** with that wallet (0x...)." : ""),
        });
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
    } catch (e) {
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
            "**query:** wallet (`0x...`), X handle (`@user` or x.com/user/...), or Farcaster (handle or farcaster.xyz/...).\n" +
            "**by:** Deployer / Fee recipient / Both (default).\n" +
            "Shows tokens + link to [full list on Bankr](https://bankr.bot/launches/search). Pagination when there are more than 5.",
          inline: false,
        },
        {
          name: "🔗 /resolve",
          value:
            "**Get wallet for X or Farcaster.** Resolves a handle (or profile URL) to its wallet address from Bankr launch data.\n" +
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
          name: "📌 Channels",
          value:
            "**Alert channel** – all new Bankr launches.\n**Watch channel** – only launches that match your watch list.",
          inline: false,
        },
      ],
      footer: { text: "Bankr: bankr.bot" },
    };
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  if (interaction.commandName === "deploy") {
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
      const result = await callBankrDeploy(body);
      if (result.simulated) {
        await interaction.editReply({
          content: `**Simulated deploy** (no tx broadcast).\nPredicted token address: \`${result.tokenAddress ?? "—"}\``,
        });
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
    } catch (e) {
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
      const out = await getTokenFees(tokenAddress);
      const { name, symbol, feeWallet, feeRecipient, cumulatedFees, hookFees, volumeUsd, estimatedCreatorFeesUsd, formatUsd: fmt, error } = out;
      const launchUrl = `https://bankr.bot/launches/${tokenAddress}`;
      const feeLabel = feeRecipient?.xUsername ? `@${feeRecipient.xUsername}` : feeRecipient?.farcasterUsername ?? feeWallet ?? "—";
      if (error && !out.launch) {
        await interaction.editReply({
          content: `**${name}** ($${symbol})\n\n${error}\n\n[View on Bankr](${launchUrl})`,
        });
        return;
      }
      const lines = [
        `**Token:** ${name} ($${symbol})`,
        `**CA:** \`${tokenAddress}\``,
        `**Fee recipient:** ${feeLabel}${feeWallet ? ` (\`${feeWallet.slice(0, 6)}…${feeWallet.slice(-4)}\`)` : ""}`,
        "",
      ];
      const hasIndexerFees = cumulatedFees && (cumulatedFees.token0Fees != null || cumulatedFees.token1Fees != null || cumulatedFees.totalFeesUsd != null);
      const hasHookFees = hookFees && (hookFees.beneficiaryFees0 > 0n || hookFees.beneficiaryFees1 > 0n);
      const hasHookData = hookFees != null; // on-chain read succeeded (even if zero)
      if (hasIndexerFees) {
        const DECIMALS = 18;
        const raw0 = cumulatedFees.token0Fees != null ? BigInt(cumulatedFees.token0Fees) : 0n;
        const raw1 = cumulatedFees.token1Fees != null ? BigInt(cumulatedFees.token1Fees) : 0n;
        const tokenAmt = Number(raw0) / 10 ** DECIMALS;
        const wethAmt = Number(raw1) / 10 ** DECIMALS;
        lines.push("**Accrued fees (indexer)** — typically claimable until claimed:");
        if (cumulatedFees.token0Fees != null) lines.push(`• Token: ${tokenAmt.toFixed(4)}`);
        if (cumulatedFees.token1Fees != null) lines.push(`• WETH: ${wethAmt.toFixed(6)}`);
        if (cumulatedFees.totalFeesUsd != null) lines.push(`• **Total (USD):** ${fmt(cumulatedFees.totalFeesUsd) ?? cumulatedFees.totalFeesUsd}`);
      } else if (hasHookFees) {
        const DECIMALS = 18;
        const tokenAmt = Number(hookFees.beneficiaryFees0) / 10 ** DECIMALS;
        const wethAmt = Number(hookFees.beneficiaryFees1) / 10 ** DECIMALS;
        lines.push("**On-chain (Rehype hook)** — beneficiary share (claimable until claimed):");
        if (hookFees.beneficiaryFees0 > 0n) lines.push(`• Token: ${tokenAmt.toFixed(4)}`);
        if (hookFees.beneficiaryFees1 > 0n) lines.push(`• WETH: ${wethAmt.toFixed(6)}`);
      } else if (hasHookData) {
        lines.push("**On-chain (Rehype hook):** No beneficiary fees accrued yet for this pool.");
      }
      if (!hasIndexerFees && !hasHookFees) {
        if (estimatedCreatorFeesUsd != null && !hasHookData) {
          lines.push(`**Estimated** creator fees (57% of 1.2% of volume): ${fmt(estimatedCreatorFeesUsd) ?? "—"}`);
        } else if (!hasHookData) {
          lines.push("_No indexer or on-chain fees for this token. Set DOPPLER_INDEXER_URL for indexer; RPC_URL is used for on-chain Rehype read._");
        }
      }
      lines.push("");
      lines.push("_Works for any token — paste any Bankr token address or launch URL. To claim: [Bankr terminal](https://bankr.bot/terminal) or `bankr fees --token " + tokenAddress + "`._");
      await interaction.editReply({
        content: lines.join("\n") + `\n\n[View on Bankr](${launchUrl})`,
      });
    } catch (e) {
      await interaction.editReply({ content: `Fees lookup failed: ${e.message}` }).catch(() => {});
    }
    return;
  }

  if (interaction.commandName !== "watch") return;

  const sub = interaction.options.getSubcommand();
  const type = interaction.options.getString("type");
  const value = interaction.options.getString("value");

  try {
    if (sub === "add") {
      if (type === "x" || type === "fc") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const { wallet, normalized } = await resolveHandleToWallet(value);
        if (!wallet) {
          await interaction.editReply({
            content: `Could not resolve **${type === "x" ? "@" : ""}${value}** to a wallet. Add a wallet address (0x...) directly with type **wallet**.`,
          });
          return;
        }
        const added = await addWallet(wallet);
        if (!added) {
          await interaction.editReply({
            content: `**${type === "x" ? "@" : ""}${normalized || value}** is already on the watch list (wallet \`${wallet}\`).`,
          });
          return;
        }
        await interaction.editReply({
          content: `Added **${type === "x" ? "@" : ""}${normalized || value}** (wallet \`${wallet}\`) to watch list.`,
        });
      } else if (type === "wallet") {
        const added = await addWallet(value);
        if (!added) {
          const valid = /^0x[a-fA-F0-9]{40}$/.test(String(value).trim());
          return interaction.reply({
            content: valid ? `That wallet is already on the watch list: \`${String(value).trim().toLowerCase()}\`.` : "Invalid wallet address (use 0x + 40 hex chars).",
            flags: MessageFlags.Ephemeral,
          });
        }
        await interaction.reply({ content: `Added wallet \`${String(value).trim().toLowerCase()}\` to watch list.`, flags: MessageFlags.Ephemeral });
      } else {
        await addKeyword(value);
        await interaction.reply({ content: `Added keyword **"${value}"** to watch list.`, flags: MessageFlags.Ephemeral });
      }
    } else if (sub === "remove") {
      if (type === "x" || type === "fc") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const { wallet, normalized } = await resolveHandleToWallet(value);
        if (!wallet) {
          await interaction.editReply({
            content: `Could not resolve **${type === "x" ? "@" : ""}${value}** to a wallet. If you added by wallet, remove with type **wallet** and the address.`,
          });
          return;
        }
        const ok = await removeWallet(wallet);
        await interaction.editReply({
          content: ok ? `Removed **${type === "x" ? "@" : ""}${normalized || value}** (wallet) from watch list.` : "That wallet was not on the watch list.",
        });
      } else if (type === "wallet") {
        const ok = await removeWallet(value);
        await interaction.reply({
          content: ok ? "Removed wallet from watch list." : "Wallet not found or invalid address.",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await removeKeyword(value);
        await interaction.reply({ content: `Removed keyword **"${value}"** from watch list.`, flags: MessageFlags.Ephemeral });
      }
    } else if (sub === "list") {
      const { wallet, keywords } = await list();
      const walletBlock = wallet.length ? wallet.map((w) => `\`${w}\``).join("\n") : "_none_";
      const kwStr = keywords.length ? keywords.map((k) => `"${k}"`).join(", ") : "_none_";
      await interaction.reply({
        content: `**Watch list**\n\n**Wallets** (X/FC handles are resolved to wallet when added):\n${walletBlock}\n\n**Keywords:** ${kwStr}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (e) {
    await interaction.reply({ content: `Error: ${e.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.login(TOKEN);
