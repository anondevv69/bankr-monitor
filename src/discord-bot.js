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
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { addX, removeX, addFc, removeFc, addWallet, removeWallet, addKeyword, removeKeyword, list } from "./watch-store.js";
import { runNotifyCycle, buildLaunchEmbed, sendTelegram } from "./notify.js";
import { lookupByDeployerOrFee } from "./lookup-deployer.js";
import { getFeesSummary } from "./fees-for-wallet.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const ALERT_CHANNEL_ID = process.env.DISCORD_ALERT_CHANNEL_ID;
const WATCH_ALERT_CHANNEL_ID = process.env.DISCORD_WATCH_ALERT_CHANNEL_ID;
const INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || "60000", 10);
const LOOKUP_PAGE_SIZE = Math.min(Math.max(parseInt(process.env.LOOKUP_PAGE_SIZE || "5", 10), 3), 25);
const LOOKUP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const lookupCache = new Map(); // messageId -> { matches, query, by, searchUrl, totalCount, possiblyCapped, createdAt }
function buildLookupEmbed(data, page) {
  const { matches, query, by, searchUrl, totalCount, possiblyCapped } = data;
  const total = totalCount > 0 ? totalCount : matches.length;
  const byLabel = by === "deployer" ? " (deployer)" : by === "fee" ? " (fee recipient)" : "";
  const totalPages = Math.ceil(matches.length / LOOKUP_PAGE_SIZE) || 1;
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const start = currentPage * LOOKUP_PAGE_SIZE;
  const pageMatches = matches.slice(start, start + LOOKUP_PAGE_SIZE);
  let description;
  let footer;
  if (total > matches.length) {
    description =
      `**${total} token(s) associated** with this wallet · **Latest ${matches.length} we can show here.**\n` +
      `Click the link below to see all ${total} on Bankr.\n**[View all ${total} on site →](${searchUrl})**`;
    footer = { text: `Showing latest ${matches.length} of ${total} · Full list on Bankr` };
  } else if (possiblyCapped) {
    description = `**At least ${matches.length} token(s)** · Latest we can show here.\n**[View full list on site →](${searchUrl})**`;
    footer = { text: "Full list on Bankr" };
  } else {
    description =
      totalPages > 1
        ? `**${total} token(s) associated** with this wallet · **5 per page.** Use Previous/Next below.\n**[View on site →](${searchUrl})**`
        : `**${total} token(s) associated** with this wallet.\n**[View on site →](${searchUrl})**`;
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
      .setName("fees")
      .setDescription("Show accrued fees (claimable) for a wallet or X/Farcaster as fee recipient")
      .addStringOption((o) =>
        o
          .setName("query")
          .setDescription("Wallet (0x...), X handle (@user or link), or Farcaster (user or link)")
          .setRequired(true)
      )
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
        if (alertChannel) {
          try {
            await alertChannel.send({ embeds: [embed] });
          } catch (e) {
            console.error(`Alert channel ${ALERT_CHANNEL_ID} failed:`, e.message);
          }
        }
        if (launch.isWatchMatch && watchChannel && watchChannel.id !== alertChannel?.id) {
          try {
            await watchChannel.send({ embeds: [embed] });
          } catch (e) {
            console.error(`Watch channel ${WATCH_ALERT_CHANNEL_ID} failed:`, e.message, "- Check bot has Send Messages + Embed Links in that channel.");
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
      await interaction.reply({ content: "This lookup has expired. Run /lookup again.", ephemeral: true }).catch(() => {});
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

  if (interaction.commandName === "lookup") {
    const query = interaction.options.getString("query");
    const by = interaction.options.getString("by") || "both";
    await interaction.deferReply({ ephemeral: true });
    try {
      const { matches, totalCount, normalized, possiblyCapped } = await lookupByDeployerOrFee(query, by);
      const searchQ = normalized || String(query).trim();
      const searchUrl = `https://bankr.bot/launches/search?q=${encodeURIComponent(searchQ)}`;
      if (matches.length === 0) {
        await interaction.editReply({
          content: `No Bankr tokens found for **${searchQ}**.\nFull search: ${searchUrl}`,
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
        "This bot helps you **watch** Bankr launches, **look up** tokens by wallet/X/Farcaster, and **check accrued fees** for fee recipients. Data: Bankr API + Doppler indexer.",
      fields: [
        {
          name: "📋 /watch",
          value:
            "**add** – Add someone to the watch list (type: X, Farcaster, wallet, or keyword + value). New launches matching them are posted to the watch channel.\n" +
            "**remove** – Remove by type + value.\n**list** – Show current watch list.",
          inline: false,
        },
        {
          name: "🔍 /lookup",
          value:
            "Search Bankr tokens by **deployer** or **fee recipient**.\n" +
            "**query:** wallet (`0x...`), X handle (`@user` or `https://x.com/user`), or Farcaster (handle or warpcast link).\n" +
            "**by:** Deployer / Fee recipient / Both (default).\n" +
            "Shows latest tokens we can return + link to [full list on Bankr](https://bankr.bot/launches/search). Pagination when there are more than 5.",
          inline: false,
        },
        {
          name: "💰 /fees",
          value:
            "**Accrued fees (claimable-style)** for a wallet or X/Farcaster **as fee recipient**.\n" +
            "**query:** Same as lookup (wallet, @handle, or link).\n" +
            "Uses the **Doppler indexer** (set `DOPPLER_INDEXER_URL` to your doppler-indexer or a public one) for `cumulatedFees`. Claim in the Bankr app or with `bankr fees claim <token>`.",
          inline: false,
        },
        {
          name: "📌 Channels",
          value:
            "**Alert channel** – all new Bankr launches.\n**Watch channel** – only launches that match your watch list.",
          inline: false,
        },
      ],
      footer: { text: "Bankr: bankr.bot | Doppler indexer for volume + fees" },
    };
    await interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
    return;
  }

  if (interaction.commandName === "fees") {
    const query = interaction.options.getString("query");
    await interaction.deferReply({ ephemeral: true });
    try {
      const out = await getFeesSummary(query);
      if (out.error) {
        await interaction.editReply({
          content: `${out.error}\n[Search on Bankr](${`https://bankr.bot/launches/search?q=${encodeURIComponent(query)}`})`,
        });
        return;
      }
      const { totalUsd, tokens, indexerUsed, feeWallet, formatUsd } = out;
      const totalStr = formatUsd(totalUsd) ?? `$${totalUsd.toFixed(2)}`;
      if (!indexerUsed || tokens.length === 0) {
        await interaction.editReply({
          content:
            `**${query}** as fee recipient: **${out.matchCount ?? 0} token(s)** in our list, but the indexer didn't return fee data.\n` +
            `Set **DOPPLER_INDEXER_URL** to an indexer that supports \`cumulatedFees\`, or use **Bankr app / \`bankr fees\`** to see claimable amounts.`,
        });
        return;
      }
      const description =
        `**Accrued fees (claimable-style)** for fee recipient.\n` +
        (feeWallet ? `Wallet: \`${feeWallet.slice(0, 10)}…${feeWallet.slice(-8)}\`\n` : "") +
        `**Total: ${totalStr}** across ${tokens.length} token(s).\n\n` +
        tokens.slice(0, 10).map((t) => `• ${t.tokenName} ($${t.tokenSymbol}): ${formatUsd(t.totalFeesUsd) ?? t.totalFeesUsd}`).join("\n") +
        (tokens.length > 10 ? `\n… and ${tokens.length - 10} more` : "") +
        `\n\nClaim via Bankr app or \`bankr fees claim <tokenAddress>\`.`;
      const embed = {
        color: 0x0052_ff,
        title: `Fees: ${query}`,
        description,
        footer: { text: "Data from Doppler indexer (cumulatedFees). Claim in Bankr." },
      };
      await interaction.editReply({ embeds: [embed] });
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
      if (type === "x") {
        await addX(value);
        await interaction.reply({ content: `Added **@${value}** to X watch list.`, ephemeral: true });
      } else if (type === "fc") {
        await addFc(value);
        await interaction.reply({ content: `Added **${value}** to Farcaster watch list.`, ephemeral: true });
      } else if (type === "wallet") {
        const ok = await addWallet(value);
        if (!ok) return interaction.reply({ content: "Invalid wallet address (use 0x + 40 hex chars).", ephemeral: true });
        await interaction.reply({ content: `Added wallet \`${value.slice(0, 10)}...${value.slice(-6)}\` to watch list.`, ephemeral: true });
      } else {
        await addKeyword(value);
        await interaction.reply({ content: `Added keyword **"${value}"** to watch list.`, ephemeral: true });
      }
    } else if (sub === "remove") {
      if (type === "x") {
        await removeX(value);
        await interaction.reply({ content: `Removed **@${value}** from X watch list.`, ephemeral: true });
      } else if (type === "fc") {
        await removeFc(value);
        await interaction.reply({ content: `Removed **${value}** from Farcaster watch list.`, ephemeral: true });
      } else if (type === "wallet") {
        const ok = await removeWallet(value);
        await interaction.reply({
          content: ok ? "Removed wallet from watch list." : "Wallet not found or invalid address.",
          ephemeral: true,
        });
      } else {
        await removeKeyword(value);
        await interaction.reply({ content: `Removed keyword **"${value}"** from watch list.`, ephemeral: true });
      }
    } else if (sub === "list") {
      const { x, fc, wallet, keywords } = await list();
      const xStr = x.length ? x.map((h) => `@${h}`).join(", ") : "_none_";
      const fcStr = fc.length ? fc.join(", ") : "_none_";
      const walletStr = wallet.length ? wallet.map((w) => `\`${w.slice(0, 6)}…${w.slice(-4)}\``).join(", ") : "_none_";
      const kwStr = keywords.length ? keywords.map((k) => `"${k}"`).join(", ") : "_none_";
      await interaction.reply({
        content: `**Watch list**\n\n**X:** ${xStr}\n**Farcaster:** ${fcStr}\n**Wallets:** ${walletStr}\n**Keywords:** ${kwStr}`,
        ephemeral: true,
      });
    }
  } catch (e) {
    await interaction.reply({ content: `Error: ${e.message}`, ephemeral: true }).catch(() => {});
  }
});

client.login(TOKEN);
