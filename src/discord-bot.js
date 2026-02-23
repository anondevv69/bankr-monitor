#!/usr/bin/env node
/**
 * Discord bot with /watch commands to manage the Bankr launch watch list.
 * Add/remove X and Farcaster users, list current watchers.
 * Runs the notify loop in the background.
 *
 * Env: DISCORD_BOT_TOKEN (required), plus all notify.js vars
 */

import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from "discord.js";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { addX, removeX, addFc, removeFc, addWallet, removeWallet, addKeyword, removeKeyword, list } from "./watch-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.DISCORD_BOT_TOKEN;
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
  ];

  try {
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log("Slash commands registered");
  } catch (e) {
    console.error("Failed to register commands:", e.message);
  }
}

async function runNotify() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(__dirname, "notify.js")],
      { stdio: "inherit", env: process.env }
    );
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands(client.application.id);

  setInterval(() => {
    runNotify().catch((e) => console.error("Notify failed:", e.message));
  }, INTERVAL);
  runNotify().catch((e) => console.error("Notify failed:", e.message));
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "watch") return;

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
