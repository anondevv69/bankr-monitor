/**
 * Telegram groups/supergroups: /walletlookup, /lookup, /token + pasted Bankr CAs (…ba3).
 * Admins: /tg_tokenlookup on|off, /tg_settings. See /tg_help.
 */

import { getTokenFees } from "./token-stats.js";
import { isBankrTokenAddress } from "./bankr-token.js";
import {
  formatTokenFeesPlain,
  runTelegramWalletLookupCommand,
  runTelegramLookupCommand,
  runTelegramTokenSlashCommand,
} from "./telegram-personal-commands.js";
import { getTelegramGroupSettings, updateTelegramGroupSettings } from "./telegram-group-settings.js";
import { hasTelegramBankrApiKeys, pickTelegramBankrApiKeyRoundRobin } from "./telegram-bankr-keys.js";

/** @returns {Promise<boolean>} */
export async function isTelegramChatAdmin(botToken, chatId, userId) {
  if (userId == null) return false;
  try {
    const url = new URL(`https://api.telegram.org/bot${botToken}/getChatMember`);
    url.searchParams.set("chat_id", String(chatId));
    url.searchParams.set("user_id", String(userId));
    const res = await fetch(url);
    const data = await res.json();
    const status = data?.result?.status;
    return status === "creator" || status === "administrator";
  } catch {
    return false;
  }
}

function parseCmd(text) {
  const trimmed = String(text || "").trim();
  const first = trimmed.split(/\s+/)[0] || "";
  const cmd = (first.split("@")[0] || "").toLowerCase();
  const rest = trimmed.slice(first.length).trim();
  return { cmd, rest, trimmed };
}

/**
 * One message often contains a pasted CA then several commands. Telegram passes the whole body as `text`;
 * the first "word" is then the CA, so /token on a later line was ignored. Use the **last** line that starts
 * with `/` for slash-command routing; keep full `text` for pasted-address detection.
 */
function pickSlashCommandLine(fullText) {
  const lines = String(fullText || "")
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("/")) return lines[i];
  }
  return String(fullText || "").trim();
}

/**
 * @param {object} p
 * @param {string} p.botToken
 * @param {string|number} p.chatId
 * @param {number|undefined} p.threadId
 * @param {string} p.text
 * @param {number|undefined} p.fromUserId
 * @param {boolean} [p.isBot]
 * @param {(msg: string, opts?: object) => Promise<void>} p.send
 * @returns {Promise<'handled'|'not_handled'>}
 *
 * Note: TELEGRAM_ALLOWED_CHAT_IDS does *not* apply here — it only limits **outbound** launch/alert posts
 * in notify.js. Any group the bot is in can use /walletlookup, /lookup, paste …ba3, etc.
 */
export async function handleTelegramGroupMessage(p) {
  const { botToken, chatId, threadId, text, fromUserId, isBot, send } = p;
  if (isBot) return "not_handled";

  const lineForSlash = pickSlashCommandLine(text);
  const { cmd, rest } = parseCmd(lineForSlash);

  if (cmd === "/start") {
    await send(
      [
        "In *groups*, use:",
        "`/tg_help` — commands",
        "`/token` `0x…ba3` — fee summary",
        "`/walletlookup` / `/lookup` — wallet & tokens",
        "",
        "_Paste a Bankr CA on its own line for auto-reply (needs `BANKR_API_KEY`)._",
        "Personal alerts & watchlist: open a *private DM* with this bot and send `/start` there.",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return "handled";
  }

  if (cmd === "/tg_help") {
    await send(
      [
        "*BankrMonitor — group*",
        "",
        "*Lookups (anyone):*",
        "`/walletlookup` — X/Farcaster / URL → wallet",
        "`/lookup` — Bankr tokens for wallet or profile",
        "`/token` — fee summary for a `0x…ba3`",
        "_Paste a Bankr contract (`…ba3`) in chat → token summary when auto-lookup is ON._",
        "",
        "*Admin:*",
        "`/tg_settings` — auto-reply on paste on/off",
        "`/tg_tokenlookup on` or `off` — toggle paste lookups",
        "",
        "_If the bot never sees pasted addresses, disable Group Privacy in @BotFather (`/setprivacy` → Disable)._",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return "handled";
  }

  if (cmd === "/tg_settings") {
    const s = await getTelegramGroupSettings(chatId);
    const onoff = s.tokenLookupInGroup !== false ? "ON" : "OFF";
    await send(
      `*Group bot settings*\n\nAuto token lookup (paste Bankr CA): *${onoff}*\n\n_Admins:_ \`/tg_tokenlookup on\` or \`off\``,
      { parse_mode: "Markdown" }
    );
    return "handled";
  }

  if (cmd === "/tg_tokenlookup") {
    const admin = await isTelegramChatAdmin(botToken, chatId, fromUserId);
    if (!admin) {
      await send("Only *group administrators* can change this setting.", { parse_mode: "Markdown" });
      return "handled";
    }
    const sub = rest.toLowerCase().trim();
    if (sub !== "on" && sub !== "off") {
      await send("Usage: `/tg_tokenlookup on` or `/tg_tokenlookup off`", { parse_mode: "Markdown" });
      return "handled";
    }
    const on = sub === "on";
    await updateTelegramGroupSettings(chatId, { tokenLookupInGroup: on });
    await send(`Auto token lookup for pasted Bankr CAs: *${on ? "ON" : "OFF"}*`, { parse_mode: "Markdown" });
    return "handled";
  }

  if (cmd === "/walletlookup" || cmd === "/wallet") {
    await runTelegramWalletLookupCommand(send, rest);
    return "handled";
  }

  if (cmd === "/lookup") {
    await runTelegramLookupCommand(send, rest);
    return "handled";
  }

  if (cmd === "/token") {
    await runTelegramTokenSlashCommand(send, rest);
    return "handled";
  }

  // Unknown slash command (e.g. /claims) — fall through to discord-bot poll loop
  if (lineForSlash.startsWith("/")) return "not_handled";

  const settings = await getTelegramGroupSettings(chatId);
  if (settings.tokenLookupInGroup === false) return "not_handled";

  const all = text.match(/0x[a-fA-F0-9]{40}/g);
  if (!all?.length) return "not_handled";
  const uniq = [...new Set(all.map((a) => a.toLowerCase()))];
  const bankr = uniq.filter(isBankrTokenAddress);
  if (bankr.length === 0) return "not_handled";

  const addr = bankr[0];
  if (!hasTelegramBankrApiKeys()) {
    await send("Set TELEGRAM_BANKR_API_KEYS or BANKR_API_KEY on the bot host for group token lookup.");
    return "handled";
  }

  try {
    const out = await getTokenFees(addr, { bankrApiKey: pickTelegramBankrApiKeyRoundRobin() });
    const msg = formatTokenFeesPlain(out, addr);
    await send(msg);
  } catch (e) {
    await send(`Token lookup failed: ${e.message}`);
  }
  return "handled";
}
