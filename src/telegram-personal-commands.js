/**
 * Commands for Telegram private chat (personal DM bot layer).
 */

import { resolveHandleToWallet, parseQuery, lookupByDeployerOrFee } from "./lookup-deployer.js";
import { getTokenFees, formatUsd } from "./token-stats.js";
import { isBankrTokenAddress } from "./bankr-token.js";
import {
  isPersonalDmsEnabled,
  isChatAllowedForPersonalFeatures,
  registerPersonalUser,
  getPersonalUser,
  addWatchlistEntry,
  removeWatchlistEntry,
  updatePersonalSettings,
  setPersonalPremium,
  TELEGRAM_PERSONAL_WATCHLIST_MAX,
} from "./telegram-personal-store.js";

async function classifyWatchArg(raw, bankrApiKey) {
  const arg = String(raw || "").trim();
  if (!arg) return { error: "Provide a value after the command." };
  const { normalized, isWallet } = parseQuery(arg);
  if (isWallet && normalized) {
    if (isBankrTokenAddress(normalized)) {
      return { type: "token", value: normalized };
    }
    return { type: "wallet", value: normalized };
  }
  const { wallet } = await resolveHandleToWallet(arg, { bankrApiKey });
  if (wallet) return { type: "wallet", value: wallet };
  return { type: "keyword", value: arg.trim().toLowerCase() };
}

function formatTokenFeesPlain(out, tokenAddress) {
  const sym = out.symbol ?? "—";
  const name = out.name ?? "—";
  const lines = [`${name} ($${sym})`, `CA: ${tokenAddress}`];
  if (out.error && !out.launch) {
    lines.push(out.error);
    return lines.join("\n");
  }
  if (out.feeWallet) lines.push(`Fee wallet: ${out.feeWallet}`);
  if (out.hookFees) {
    const w = Number(out.hookFees.beneficiaryFees0) / 1e18;
    const t = Number(out.hookFees.beneficiaryFees1) / 1e18;
    if (w > 0 || t > 0) lines.push(`Claimable: ${w.toFixed(4)} WETH · ${t.toFixed(2)} ${sym}`);
  }
  if (out.cumulatedFees?.totalFeesUsd != null) {
    const u = formatUsd(out.cumulatedFees.totalFeesUsd);
    if (u) lines.push(`Indexer fees USD: ${u}`);
  }
  lines.push(`Bankr: https://bankr.bot/launches/${tokenAddress}`);
  return lines.join("\n");
}

/**
 * @param {{ chatId: number|string, text: string, send: (msg: string, opts?: object) => Promise<void> }} ctx
 */
export async function handlePersonalTelegramCommand(ctx) {
  const chatId = String(ctx.chatId);
  const text = String(ctx.text || "").trim();
  const send = ctx.send;
  const bankrApiKey = process.env.BANKR_API_KEY;

  if (!isPersonalDmsEnabled()) return;

  if (!isChatAllowedForPersonalFeatures(chatId)) {
    await send("This account is not allowlisted for personal alerts. Ask the bot admin to add your Telegram user ID to TELEGRAM_DM_ALLOWED_USER_IDS.");
    return;
  }

  const cmd = text.split(/\s+/)[0]?.toLowerCase() || "";
  const rest = text.slice(cmd.length).trim();

  if (cmd === "/start" || cmd === "/help") {
    await registerPersonalUser(chatId);
    await send(
      [
        "BankrMonitor — personal alerts",
        "",
        "All personal DMs are delayed vs Discord (TELEGRAM_DM_DELAY_MS or TELEGRAM_HOT_PING_DELAY_MS, default 60s).",
        "",
        "Commands:",
        "/add <wallet | 0x…ba3 token | @handle | keyword>",
        "/remove <value>",
        "/watchlist",
        "/toggle_launch · /toggle_firehose · /toggle_claims",
        "/toggle_trending · /toggle_hot (premium)",
        "/wallet <0x | @ | URL>",
        "/token <0x…ba3 | Bankr URL>",
        "/settings",
        `/premium <code> (admin code from TELEGRAM_PREMIUM_CODE)`,
        "",
        `Max ${TELEGRAM_PERSONAL_WATCHLIST_MAX} watch items.`,
      ].join("\n")
    );
    return;
  }

  let user = await getPersonalUser(chatId);
  if (!user) {
    await send("Send /start first.");
    return;
  }

  if (cmd === "/settings") {
    const s = user.settings;
    await send(
      [
        "Settings:",
        `Launch watch: ${s.launchAlerts !== false ? "ON" : "OFF"}`,
        `Firehose: ${s.firehose ? "ON" : "OFF"}`,
        `Claims: ${s.claimAlerts !== false ? "ON" : "OFF"}`,
        `Trending: ${s.trending !== false ? "ON" : "OFF"}`,
        `Hot: ${s.hot ? "ON" : "OFF"} (${user.premium ? "premium" : "need /premium"})`,
      ].join("\n")
    );
    return;
  }

  async function toggle(key) {
    const u = await getPersonalUser(chatId);
    if (!u) return send("Send /start first.");
    let cur;
    if (key === "launchAlerts") cur = u.settings.launchAlerts !== false;
    else if (key === "claimAlerts") cur = u.settings.claimAlerts !== false;
    else if (key === "trending") cur = u.settings.trending !== false;
    else cur = !!u.settings[key];
    const next = !cur;
    if (key === "hot" && next && !u.premium) {
      return send("Hot alerts are premium only. Use /premium with the admin code first.");
    }
    await updatePersonalSettings(chatId, { [key]: next });
    await send(`${key} → ${next ? "ON" : "OFF"}`);
  }

  if (cmd === "/toggle_launch") return toggle("launchAlerts");
  if (cmd === "/toggle_firehose") return toggle("firehose");
  if (cmd === "/toggle_claims") return toggle("claimAlerts");
  if (cmd === "/toggle_trending") return toggle("trending");
  if (cmd === "/toggle_hot") return toggle("hot");

  if (cmd === "/add") {
    if (!rest) return send("Usage: /add <wallet | token 0x…ba3 | @handle | keyword>");
    const classified = await classifyWatchArg(rest, bankrApiKey);
    if (classified.error) return send(classified.error);
    const r = await addWatchlistEntry(chatId, { type: classified.type, value: classified.value });
    if (!r.ok && r.error === "LIMIT") {
      return send(`Max ${TELEGRAM_PERSONAL_WATCHLIST_MAX} items. Remove one with /remove first.`);
    }
    return send(r.duplicate ? "Already on your list." : `Added (${classified.type}): ${classified.value}`);
  }

  if (cmd === "/remove") {
    if (!rest) return send("Usage: /remove <value>");
    const r = await removeWatchlistEntry(chatId, rest);
    return send(r.ok ? "Removed." : "Not found.");
  }

  if (cmd === "/watchlist") {
    const u = await getPersonalUser(chatId);
    const list = u?.watchlist || [];
    if (list.length === 0) return send("Watchlist empty.");
    const lines = list.map((e) => `• ${e.type}: ${e.value}`);
    return send(lines.join("\n"));
  }

  if (cmd === "/wallet") {
    if (!rest) return send("Usage: /wallet <0x | @handle | profile URL>");
    if (!bankrApiKey) return send("Set BANKR_API_KEY on the bot for wallet lookup.");
    await send("Looking up…");
    try {
      const { matches, totalCount, searchUrl } = await lookupByDeployerOrFee(rest, "both", "newest", { bankrApiKey });
      if (!matches.length) {
        return send(`No tokens found. Search: ${searchUrl}`);
      }
      const top = matches.slice(0, 5);
      const lines = top.map((m) => `• $${m.tokenSymbol} · ${m.tokenAddress} · ${m.bankrUrl}`);
      const more = totalCount > top.length ? `\n…+${totalCount - top.length} more on Bankr` : "";
      await send(`Wallet lookup (${Math.min(matches.length, top.length)} shown)\n\n${lines.join("\n")}${more}`);
    } catch (e) {
      await send(`Lookup failed: ${e.message}`);
    }
    return;
  }

  if (cmd === "/token") {
    if (!rest) return send("Usage: /token <0x… or Bankr launch URL>");
    const m = rest.match(/0x[a-fA-F0-9]{40}/);
    const addr = m ? m[0].toLowerCase() : null;
    if (!addr || !isBankrTokenAddress(addr)) {
      return send("Need a Bankr token address (0x…ba3) or URL containing it.");
    }
    await send("Fetching token…");
    try {
      const out = await getTokenFees(addr, { bankrApiKey });
      await send(formatTokenFeesPlain(out, addr));
    } catch (e) {
      await send(`Token lookup failed: ${e.message}`);
    }
    return;
  }

  if (cmd === "/premium") {
    const code = process.env.TELEGRAM_PREMIUM_CODE;
    if (!code || rest !== code) {
      return send("Invalid or missing code.");
    }
    await setPersonalPremium(chatId, true);
    await send("Premium enabled. You can turn on /toggle_hot.");
    return;
  }

  await send("Unknown command. Try /help");
}
