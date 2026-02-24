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

import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from "discord.js";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { addX, removeX, addFc, removeFc, addWallet, removeWallet, addKeyword, removeKeyword, list } from "./watch-store.js";
import { runNotifyCycle, buildLaunchEmbed, sendTelegram } from "./notify.js";
import { lookupByDeployerOrFee } from "./lookup-deployer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const ALERT_CHANNEL_ID = process.env.DISCORD_ALERT_CHANNEL_ID;
const WATCH_ALERT_CHANNEL_ID = process.env.DISCORD_WATCH_ALERT_CHANNEL_ID;
const INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || "60000", 10);

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
          .setDescription("Wallet (0x...), X: @user or x(user) or x.com/user link, Farcaster: user or F(user) or warpcast.com link")
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

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "lookup") {
    const query = interaction.options.getString("query");
    const by = interaction.options.getString("by") || "both";
    await interaction.deferReply({ ephemeral: true });
    try {
      const { matches, totalCount, normalized } = await lookupByDeployerOrFee(query, by);
      const searchUrl = `https://bankr.bot/launches/search?q=${encodeURIComponent(String(query).trim())}`;
      if (matches.length === 0) {
        await interaction.editReply({
          content: `No Bankr tokens found for **${query}** (normalized: \`${normalized}\`).\nFull search: ${searchUrl}`,
        });
        return;
      }
      const pageSize = 25;
      const total = totalCount > 0 ? totalCount : matches.length;
      const byLabel = by === "deployer" ? " (deployer)" : by === "fee" ? " (fee recipient)" : "";
      const embed = {
        color: 0x0052_ff,
        title: `Bankr lookup: ${query}${byLabel}`,
        description: `**${total} token(s) total** · [Full list on site](${searchUrl})`,
        fields: matches.slice(0, pageSize).map((m) => ({
          name: `${m.tokenName} ($${m.tokenSymbol})`,
          value: `CA: \`${m.tokenAddress}\`\n[Bankr](${m.bankrUrl})`,
          inline: true,
        })),
        footer:
          matches.length > pageSize
            ? { text: `Showing 1–${pageSize} of ${total} · Use site for full list & pagination` }
            : total > matches.length
              ? { text: `${matches.length} shown (${total} total) · Use site for full list` }
              : undefined,
      };
      await interaction.editReply({ embeds: [embed] });
    } catch (e) {
      await interaction.editReply({ content: `Lookup failed: ${e.message}` }).catch(() => {});
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
