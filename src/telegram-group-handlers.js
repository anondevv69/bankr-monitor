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
 * @param {object} p
 * @param {string} p.botToken
 * @param {string|number} p.chatId
 * @param {number|undefined} p.threadId
 * @param {string} p.text
 * @param {number|undefined} p.fromUserId
 * @param {boolean} [p.isBot]
 * @param {string[]|null} p.allowedChatIds — same semantics as TELEGRAM_ALLOWED_CHAT_IDS (null/empty = all chats)
 * @param {(msg: string, opts?: object) => Promise<void>} p.send
 * @returns {Promise<'handled'|'not_handled'>}
 */
export async function handleTelegramGroupMessage(p) {
  const { botToken, chatId, threadId, text, fromUserId, isBot, allowedChatIds, send } = p;
  if (isBot) return "not_handled";

  const inAllowed = !allowedChatIds?.length || allowedChatIds.includes(String(chatId));
  if (!inAllowed) return "not_handled";

  const { cmd, rest } = parseCmd(text);

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

  if (text.startsWith("/")) return "not_handled";

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
