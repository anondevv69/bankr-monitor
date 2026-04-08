/**
 * Telegram groups/supergroups: /walletlookup, /lookup, /token + pasted Bankr CAs (…ba3).
 * Admins: /tg_tokenlookup, /tg_watch, /tg_alerts, /tg_settings. See /tg_help.
 */

import { getTokenFees } from "./token-stats.js";
import { isBankrTokenAddress } from "./bankr-token.js";
import { parseQuery, resolveHandleToWallet } from "./lookup-deployer.js";
import { defaultBankrApiKey } from "./bankr-env-key.js";
import {
  classifyWatchArg,
  sendTelegramTokenDetailReply,
  runTelegramWalletLookupCommand,
  runTelegramLookupCommand,
  runTelegramTokenSlashCommand,
} from "./telegram-personal-commands.js";
import {
  getTelegramGroupSettings,
  updateTelegramGroupSettings,
  updateTelegramGroupWatchlist,
  getTelegramGroupWatchListDisplay,
} from "./telegram-group-settings.js";
import { hasTelegramBankrApiKeys, pickTelegramBankrApiKeyRoundRobin } from "./telegram-bankr-keys.js";
import { BRAND_DISPLAY_NAME } from "./brand.js";
import { extractTickers, resolveCashtagToBankrToken, formatCashtagResolvePreambleHtml } from "./cashtag-resolve.js";

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
  let cmd = (first.split("@")[0] || "").toLowerCase();
  if (cmd === "/tg_watchlist") cmd = "/tg_watch";
  const rest = trimmed.slice(first.length).trim();
  return { cmd, rest, trimmed };
}

function bankrKeyForGroupCommands() {
  return hasTelegramBankrApiKeys() ? pickTelegramBankrApiKeyRoundRobin() : defaultBankrApiKey();
}

/** Same resolution as Discord /alert-watchlist wallet rows. */
async function resolveWatchlistWalletInput(raw) {
  const val = String(raw ?? "").trim();
  if (!val) return { wallet: null, error: "Provide a wallet address or X/Farcaster profile/URL." };
  const { normalized, isWallet } = parseQuery(val);
  if (isWallet && normalized) return { wallet: normalized };
  const { wallet, normalized: norm } = await resolveHandleToWallet(val, { bankrApiKey: bankrKeyForGroupCommands() });
  if (wallet) return { wallet, resolvedLabel: norm || val };
  return {
    wallet: null,
    error:
      "Could not resolve that to a wallet. Use a 0x address or an X/Farcaster URL or @handle. Set BANKR_API_KEY or TELEGRAM_BANKR_API_KEYS on the bot host.",
  };
}

const WATCH_TYPE_ALIASES = {
  wallet: "wallet",
  w: "wallet",
  x: "x",
  twitter: "x",
  fc: "fc",
  farcaster: "fc",
  keyword: "keywords",
  keywords: "keywords",
  kw: "keywords",
};

function parseOnOff(s) {
  const t = String(s || "").trim().toLowerCase();
  if (t === "on" || t === "1" || t === "true" || t === "yes") return true;
  if (t === "off" || t === "0" || t === "false" || t === "no" || t === "clear") return false;
  return null;
}

function parseTopicId(s) {
  const t = String(s || "").trim().toLowerCase();
  if (t === "" || t === "off" || t === "clear" || t === "none") return null;
  const n = parseInt(t, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * @param {(msg: string, opts?: object) => Promise<void>} send
 * @param {string|number} chatId
 * @param {string} rest
 * @param {number|undefined} fromUserId
 * @param {string} botToken
 */
async function handleTgWatchCommand(send, chatId, rest, fromUserId, botToken) {
  const parts = rest.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] || "").toLowerCase();

  if (!sub || sub === "help") {
    await send(
      [
        "*Group watch list* (alerts the whole group when a launch matches)",
        "",
        "`/tg_watch list` — show entries",
        "`/tg_watch add wallet` `0x…` or profile URL",
        "`/tg_watch add x` `@handle` or X URL",
        "`/tg_watch add fc` `handle` or Warpcaster URL",
        "`/tg_watch add keyword` `phrase`",
        "`/tg_watch remove` `<type>` `<same as add>`",
        "",
        "_Only group admins can add or remove._",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (sub === "list") {
    const wl = await getTelegramGroupWatchListDisplay(chatId);
    const fmtX = (arr) => (arr.length ? arr.map((e) => (e.name ? `${e.name} (@${e.value})` : `@${e.value}`)).join(", ") : "none");
    const fmtFc = (arr) => (arr.length ? arr.map((e) => (e.name ? `${e.name} (${e.value})` : e.value)).join(", ") : "none");
    const fmtWallet = (arr) =>
      arr.length ? arr.map((e) => (e.name ? `${e.name} (${e.value})` : e.value)).join(", ") : "none";
    const fmtKw = (arr) => (arr.length ? arr.map((e) => (e.name ? `${e.name} ("${e.value}")` : `"${e.value}"`)).join(", ") : "none");
    await send(
      ["*This group's watch list*", `X: ${fmtX(wl.x)}`, `Farcaster: ${fmtFc(wl.fc)}`, `Wallets: ${fmtWallet(wl.wallet)}`, `Keywords: ${fmtKw(wl.keywords)}`].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  const admin = await isTelegramChatAdmin(botToken, chatId, fromUserId);
  if (!admin) {
    await send("Only *group administrators* can add or remove watch list entries.", { parse_mode: "Markdown" });
    return;
  }

  if (sub !== "add" && sub !== "remove") {
    await send("Unknown subcommand. Try `/tg_watch list` or `/tg_help`.", { parse_mode: "Markdown" });
    return;
  }

  const typeRaw = (parts[1] || "").toLowerCase();
  const type = WATCH_TYPE_ALIASES[typeRaw];
  if (!type) {
    await send("Specify type: `wallet`, `x`, `fc`, or `keyword`.", { parse_mode: "Markdown" });
    return;
  }

  const value = parts.slice(2).join(" ").trim();
  if (!value) {
    await send("Provide a value after the type.", { parse_mode: "Markdown" });
    return;
  }

  const add = sub === "add";

  if (type === "wallet") {
    const needsResolve = value && !parseQuery(value).isWallet;
    if (needsResolve) await send("Resolving profile…");
    const resolved = await resolveWatchlistWalletInput(value);
    if (!resolved.wallet) {
      await send(resolved.error ?? "Could not resolve wallet.");
      return;
    }
    const addr = resolved.wallet;
    const ok = await updateTelegramGroupWatchlist(chatId, "wallet", addr, add);
    const extra = resolved.resolvedLabel ? ` (from ${resolved.resolvedLabel})` : "";
    if (add) {
      await send(
        ok ? `Added wallet ${addr} to this group's watch list.${extra}` : `That wallet is already on the list (${addr})${extra}.`
      );
    } else {
      await send(ok ? `Removed wallet ${addr} from this group's watch list.` : "That wallet was not on the watch list.");
    }
    return;
  }

  if (type === "x" || type === "fc") {
    const { normalized, isWallet } = parseQuery(value);
    if (isWallet || !normalized) {
      await send(isWallet ? "Use the wallet type for 0x addresses." : "Could not parse that handle or URL.");
      return;
    }
    const ok = await updateTelegramGroupWatchlist(chatId, type, normalized, add);
    const label = type === "x" ? `@${normalized}` : normalized;
    if (add) {
      await send(ok ? `Added ${label} to this group's watch list.` : `${label} is already on the list.`, { parse_mode: "Markdown" });
    } else {
      await send(ok ? `Removed ${label} from this group's watch list.` : "That entry was not on the watch list.", { parse_mode: "Markdown" });
    }
    return;
  }

  // keywords
  const kw = value.trim().toLowerCase();
  if (!kw) {
    await send("Keyword cannot be empty.", { parse_mode: "Markdown" });
    return;
  }
  const ok = await updateTelegramGroupWatchlist(chatId, "keywords", kw, add);
  if (add) {
    await send(ok ? `Added keyword "${kw}" to this group's watch list.` : `"${kw}" is already on the list.`, { parse_mode: "Markdown" });
  } else {
    await send(ok ? `Removed keyword "${kw}" from this group's watch list.` : "Keyword not found (stored lowercase).", { parse_mode: "Markdown" });
  }
}

/**
 * @param {(msg: string, opts?: object) => Promise<void>} send
 * @param {string|number} chatId
 * @param {string} rest
 * @param {number|undefined} fromUserId
 * @param {string} botToken
 */
async function handleTgAlertsCommand(send, chatId, rest, fromUserId, botToken) {
  const parts = rest.trim().split(/\s+/).filter(Boolean);
  const admin = await isTelegramChatAdmin(botToken, chatId, fromUserId);

  if (parts.length === 0) {
    const s = await getTelegramGroupSettings(chatId);
    const tw = s.topicWatch != null && s.topicWatch !== "" ? String(s.topicWatch) : "—";
    const th = s.topicHot != null && s.topicHot !== "" ? String(s.topicHot) : "—";
    const tt = s.topicTrending != null && s.topicTrending !== "" ? String(s.topicTrending) : "—";
    await send(
      [
        "*Group alerts*",
        "",
        `Watch list matches: *${s.alertWatchMatch !== false ? "ON" : "OFF"}*`,
        `Hot: *${s.alertHot === true ? "ON" : "OFF"}*`,
        `Trending: *${s.alertTrending === true ? "ON" : "OFF"}*`,
        "",
        `Forum topics (optional): watch ${tw} · hot ${th} · trending ${tt}`,
        "",
        "_Admins:_ `/tg_alerts watch on` · `/tg_alerts hot off` · `/tg_alerts topic watch 5` (or `off`)",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (parts[0].toLowerCase() === "topic") {
    if (!admin) {
      await send("Only *group administrators* can change topic IDs.", { parse_mode: "Markdown" });
      return;
    }
    const which = (parts[1] || "").toLowerCase();
    const idRaw = parts.slice(2).join(" ").trim();
    const keyMap = { watch: "topicWatch", hot: "topicHot", trending: "topicTrending" };
    const key = keyMap[which];
    if (!key) {
      await send("Usage: `/tg_alerts topic watch|hot|trending <topic id|off>`", { parse_mode: "Markdown" });
      return;
    }
    const tid = parseTopicId(idRaw);
    if (idRaw && tid === null && !["off", "clear", "none"].includes(idRaw.toLowerCase())) {
      await send("Invalid topic id. Use a number, or `off` to clear.", { parse_mode: "Markdown" });
      return;
    }
    await updateTelegramGroupSettings(chatId, { [key]: tid });
    await send(`Saved *${which}* topic → ${tid != null ? `\`${tid}\`` : "main chat"}`, { parse_mode: "Markdown" });
    return;
  }

  if (parts.length >= 2) {
    const kind = parts[0].toLowerCase();
    const on = parseOnOff(parts[1]);
    if (on === null) {
      await send("Use `on` or `off`. Example: `/tg_alerts hot on`", { parse_mode: "Markdown" });
      return;
    }
    const fieldMap = { watch: "alertWatchMatch", hot: "alertHot", trending: "alertTrending" };
    const field = fieldMap[kind];
    if (!field) {
      await send("Unknown flag. Use `watch`, `hot`, or `trending`.", { parse_mode: "Markdown" });
      return;
    }
    if (!admin) {
      await send("Only *group administrators* can change alert settings.", { parse_mode: "Markdown" });
      return;
    }
    await updateTelegramGroupSettings(chatId, { [field]: on });
    await send(`*${kind}* alerts: *${on ? "ON" : "OFF"}*`, { parse_mode: "Markdown" });
    return;
  }

  await send("Try `/tg_alerts` with no args to see status, or `/tg_help`.", { parse_mode: "Markdown" });
}

/** Same as `/tg_watch` but accepts DM-style `/add 0x…` / `@handle` / keyword (group menu). */
async function handleGroupWatchAddAlias(send, chatId, rest, fromUserId, botToken) {
  const t = rest.trim();
  if (!t) {
    await send(
      "Usage: `/add wallet …` · `/add x …` · `/add keyword …` — or shorthand: `/add 0x…`, `/add @handle`, `/add myphrase` (same rules as DMs)."
    );
    return;
  }
  const first = t.split(/\s+/)[0].toLowerCase();
  if (["wallet", "w", "x", "twitter", "fc", "farcaster", "keyword", "keywords", "kw"].includes(first)) {
    await handleTgWatchCommand(send, chatId, `add ${t}`, fromUserId, botToken);
    return;
  }
  const key = bankrKeyForGroupCommands();
  const classified = await classifyWatchArg(t, key);
  if (classified.error) {
    await send(classified.error);
    return;
  }
  if (classified.type === "wallet") {
    await handleTgWatchCommand(send, chatId, `add wallet ${classified.value}`, fromUserId, botToken);
    return;
  }
  if (classified.type === "keyword") {
    await handleTgWatchCommand(send, chatId, `add keyword ${classified.value}`, fromUserId, botToken);
    return;
  }
  await send(
    "For a token contract in groups, add the **deployer wallet** (`/add 0x…` resolves) or a **keyword**. To require explicit types, use `/tg_watch add wallet|x|fc|keyword …`."
  );
}

/** Same as `/tg_watch remove …` with DM-style value. */
async function handleGroupWatchRemoveAlias(send, chatId, rest, fromUserId, botToken) {
  const t = rest.trim();
  if (!t) {
    await send("Usage: `/remove wallet …` · `/remove keyword …` — or `/remove 0x…` / `/remove phrase`");
    return;
  }
  const first = t.split(/\s+/)[0].toLowerCase();
  if (["wallet", "w", "x", "twitter", "fc", "farcaster", "keyword", "keywords", "kw"].includes(first)) {
    await handleTgWatchCommand(send, chatId, `remove ${t}`, fromUserId, botToken);
    return;
  }
  const key = bankrKeyForGroupCommands();
  const classified = await classifyWatchArg(t, key);
  if (classified.error) {
    await send(classified.error);
    return;
  }
  if (classified.type === "wallet") {
    await handleTgWatchCommand(send, chatId, `remove wallet ${classified.value}`, fromUserId, botToken);
    return;
  }
  if (classified.type === "keyword") {
    await handleTgWatchCommand(send, chatId, `remove keyword ${classified.value}`, fromUserId, botToken);
    return;
  }
  await send("Use `/tg_watch remove …` with type, or remove by keyword / deployer wallet as above.");
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
        "`/tg_watch` · `/add` · `/remove` · `/watchlist` — group watch list",
        "`/tg_alerts` — watch / hot / trending toggles",
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
        `*${BRAND_DISPLAY_NAME} — group*`,
        "",
        "*Lookups (anyone):*",
        "`/walletlookup` — X/Farcaster / URL → wallet",
        "`/lookup` — Bankr tokens for wallet or profile",
        "`/token` — fee summary for `0x…ba3` or `$TICKER` (resolves to highest-mcap Bankr match)",
        "_Paste a Bankr contract (`…ba3`) or a cashtag (`$SYMBOL`) → token summary when auto-lookup is ON._",
        "",
        "*Group alerts (anyone can list; admins add/remove):*",
        "`/tg_watch` · `/add` · `/remove` · `/watchlist` — group watch list (same idea as DMs)",
        "`/tg_alerts` — watch-match, hot, trending (and optional forum topic ids)",
        "",
        "*Admin — paste behavior:*",
        "`/tg_settings` — auto-reply on paste on/off",
        "`/tg_tokenlookup on` or `off` — toggle paste lookups",
        "",
        "_If the bot never sees pasted addresses, disable Group Privacy in @BotFather (`/setprivacy` → Disable)._",
        "_Outbound alerts require the chat in `TELEGRAM_ALLOWED_CHAT_IDS` when that env is set._",
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

  if (cmd === "/tg_watch") {
    await handleTgWatchCommand(send, chatId, rest, fromUserId, botToken);
    return "handled";
  }

  if (cmd === "/tg_alerts") {
    await handleTgAlertsCommand(send, chatId, rest, fromUserId, botToken);
    return "handled";
  }

  if (cmd === "/watchlist") {
    await handleTgWatchCommand(send, chatId, "list", fromUserId, botToken);
    return "handled";
  }

  if (cmd === "/add") {
    await handleGroupWatchAddAlias(send, chatId, rest, fromUserId, botToken);
    return "handled";
  }

  if (cmd === "/remove") {
    await handleGroupWatchRemoveAlias(send, chatId, rest, fromUserId, botToken);
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
  const uniq = all?.length ? [...new Set(all.map((a) => a.toLowerCase()))] : [];
  const bankr = uniq.filter(isBankrTokenAddress);

  let addr = bankr[0] ?? null;
  let preambleHtml;

  if (!addr) {
    if (uniq.length > 0) return "not_handled";
    const tickers = extractTickers(text);
    if (tickers.length === 0) return "not_handled";
    if (!hasTelegramBankrApiKeys()) {
      await send("Set TELEGRAM_BANKR_API_KEYS or BANKR_API_KEY on the bot host for group token lookup.");
      return "handled";
    }
    const resolved = await resolveCashtagToBankrToken(tickers[0]);
    if (!resolved) return "not_handled";
    addr = resolved.address;
    preambleHtml = formatCashtagResolvePreambleHtml(resolved);
  }

  if (!hasTelegramBankrApiKeys()) {
    await send("Set TELEGRAM_BANKR_API_KEYS or BANKR_API_KEY on the bot host for group token lookup.");
    return "handled";
  }

  try {
    const bankrApiKey = pickTelegramBankrApiKeyRoundRobin();
    const out = await getTokenFees(addr, { bankrApiKey });
    if (preambleHtml) {
      await send(preambleHtml, { parse_mode: "HTML" });
    }
    await sendTelegramTokenDetailReply(send, out, addr, bankrApiKey);
  } catch (e) {
    await send(`Token lookup failed: ${e.message}`);
  }
  return "handled";
}
