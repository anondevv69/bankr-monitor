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
import { addX, removeX, addFc, removeFc, list } from "./watch-store.js";

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
            o.setName("type").setDescription("X or Farcaster").setRequired(true).addChoices(
              { name: "X (Twitter)", value: "x" },
              { name: "Farcaster", value: "fc" }
            )
          )
          .addStringOption((o) =>
            o.setName("handle").setDescription("Handle (e.g. thryxagi or dwr.eth)").setRequired(true)
          )
      )
      .addSubcommand((s) =>
        s
          .setName("remove")
          .setDescription("Remove user from watch list")
          .addStringOption((o) =>
            o.setName("type").setDescription("X or Farcaster").setRequired(true).addChoices(
              { name: "X (Twitter)", value: "x" },
              { name: "Farcaster", value: "fc" }
            )
          )
          .addStringOption((o) =>
            o.setName("handle").setDescription("Handle to remove").setRequired(true)
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
  const handle = interaction.options.getString("handle");

  try {
    if (sub === "add") {
      if (type === "x") {
        await addX(handle);
        await interaction.reply({ content: `Added **@${handle}** to X watch list.`, ephemeral: true });
      } else {
        await addFc(handle);
        await interaction.reply({ content: `Added **${handle}** to Farcaster watch list.`, ephemeral: true });
      }
    } else if (sub === "remove") {
      if (type === "x") {
        await removeX(handle);
        await interaction.reply({ content: `Removed **@${handle}** from X watch list.`, ephemeral: true });
      } else {
        await removeFc(handle);
        await interaction.reply({ content: `Removed **${handle}** from Farcaster watch list.`, ephemeral: true });
      }
    } else if (sub === "list") {
      const { x, fc } = await list();
      const xStr = x.length ? x.map((h) => `@${h}`).join(", ") : "_none_";
      const fcStr = fc.length ? fc.join(", ") : "_none_";
      await interaction.reply({
        content: `**Watch list**\n\n**X:** ${xStr}\n**Farcaster:** ${fcStr}`,
        ephemeral: true,
      });
    }
  } catch (e) {
    await interaction.reply({ content: `Error: ${e.message}`, ephemeral: true }).catch(() => {});
  }
});

client.login(TOKEN);
