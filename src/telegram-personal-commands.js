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
  TELEGRAM_PERSONAL_WATCHLIST_MAX,
} from "./telegram-personal-store.js";
import { hasTelegramBankrApiKeys, pickTelegramBankrApiKeyRoundRobin } from "./telegram-bankr-keys.js";

/** Strip @BotName suffix from /command@bot */
function parseCommandLine(text) {
  const trimmed = String(text || "").trim();
  const first = trimmed.split(/\s+/)[0] || "";
  const cmd = (first.split("@")[0] || "").toLowerCase();
  const rest = trimmed.slice(first.length).trim();
  return { cmd, rest, trimmed };
}

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

export function formatTokenFeesPlain(out, tokenAddress) {
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

async function runTokenLookupForChat(send, addr, bankrApiKey) {
  const tokenAddress = addr.toLowerCase();
  if (!isBankrTokenAddress(tokenAddress)) {
    await send("Need a Bankr token address (0x…ba3) or Bankr launch URL.");
    return;
  }
  await send("Fetching token…");
  try {
    const out = await getTokenFees(tokenAddress, { bankrApiKey });
    await send(formatTokenFeesPlain(out, tokenAddress));
  } catch (e) {
    await send(`Token lookup failed: ${e.message}`);
  }
}

const ALERT_KEYS = {
  launch: "launchAlerts",
  claims: "claimAlerts",
  trending: "trending",
  hot: "hot",
};

/**
 * @param {{ chatId: number|string, text: string, send: (msg: string, opts?: object) => Promise<void> }} ctx
 */
export async function handlePersonalTelegramCommand(ctx) {
  const chatId = String(ctx.chatId);
  const send = ctx.send;
  const { cmd, rest, trimmed } = parseCommandLine(ctx.text);

  if (!isPersonalDmsEnabled()) return;

  if (!isChatAllowedForPersonalFeatures(chatId)) {
    await send("This account is not allowlisted for personal alerts. Contact the bot admin.");
    return;
  }

  // Lone Bankr CA in a DM → token lookup (no /start required)
  const loneCa = trimmed.match(/^(0x[a-fA-F0-9]{40})$/i);
  if (loneCa && isBankrTokenAddress(loneCa[1])) {
    if (!hasTelegramBankrApiKeys()) {
      return send("Set TELEGRAM_BANKR_API_KEYS or BANKR_API_KEY on the bot for token lookup.");
    }
    await runTokenLookupForChat(send, loneCa[1], pickTelegramBankrApiKeyRoundRobin());
    return;
  }

  if (cmd === "/start" || cmd === "/help") {
    await registerPersonalUser(chatId);
    await send(
      [
        "BankrMonitor — personal alerts",
        "",
        "Commands:",
        "/add <wallet | 0x…ba3 token | @handle | keyword>",
        "/remove <value>",
        "/watchlist",
        "/alerts — show toggles; `/alerts launch|claims|trending|hot` (launch & claims need items on /watchlist)",
        "/walletlookup <0x | @handle | URL>",
        "/token <0x…ba3 | Bankr launch URL>",
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

  function alertsStatusLines(s) {
    return [
      "Alerts (send `/alerts <name>` to toggle):",
      `• launch — watchlist matches: ${s.launchAlerts !== false ? "ON" : "OFF"}`,
      `• claims — fee claims matching your watchlist: ${s.claimAlerts !== false ? "ON" : "OFF"}`,
      `• trending — trending token pings: ${s.trending !== false ? "ON" : "OFF"}`,
      `• hot — hot launch pings: ${s.hot ? "ON" : "OFF"}`,
      "",
      "Launch & claim DMs only run when your watchlist has at least one item (use /add).",
    ].join("\n");
  }

  async function toggleSetting(key) {
    const u = await getPersonalUser(chatId);
    if (!u) return send("Send /start first.");
    let cur;
    if (key === "launchAlerts") cur = u.settings.launchAlerts !== false;
    else if (key === "claimAlerts") cur = u.settings.claimAlerts !== false;
    else if (key === "trending") cur = u.settings.trending !== false;
    else cur = !!u.settings[key];
    const next = !cur;
    await updatePersonalSettings(chatId, { [key]: next });
    const label =
      key === "launchAlerts"
        ? "launch"
        : key === "claimAlerts"
          ? "claims"
          : key;
    await send(`${label} → ${next ? "ON" : "OFF"}`);
  }

  if (cmd === "/alerts" || cmd === "/settings") {
    const u = await getPersonalUser(chatId);
    if (!u) return send("Send /start first.");
    const sub = rest.toLowerCase().split(/\s+/)[0] || "";
    if (!sub) {
      await send(alertsStatusLines(u.settings));
      return;
    }
    const mapKey = ALERT_KEYS[sub];
    if (!mapKey) {
      await send(
        `Unknown alert "${rest}". Use: launch, claims, trending, hot.\n\n${alertsStatusLines(u.settings)}`
      );
      return;
    }
    return toggleSetting(mapKey);
  }

  if (cmd === "/toggle_launch") return toggleSetting("launchAlerts");
  if (cmd === "/toggle_firehose") {
    return send("Every-launch firehose is not available in personal DMs. Use the public Telegram channel or group topic for the full feed.");
  }
  if (cmd === "/toggle_claims") return toggleSetting("claimAlerts");
  if (cmd === "/toggle_trending") return toggleSetting("trending");
  if (cmd === "/toggle_hot") return toggleSetting("hot");

  if (cmd === "/add") {
    if (!rest) return send("Usage: /add <wallet | token 0x…ba3 | @handle | keyword>");
    const classified = await classifyWatchArg(rest, pickTelegramBankrApiKeyRoundRobin());
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

  if (cmd === "/walletlookup" || cmd === "/wallet") {
    if (!rest) return send("Usage: /walletlookup <0x | @handle | profile URL>");
    if (!hasTelegramBankrApiKeys()) {
      return send("Set TELEGRAM_BANKR_API_KEYS or BANKR_API_KEY on the bot for wallet lookup.");
    }
    await send("Looking up…");
    try {
      const { matches, totalCount, searchUrl, normalized, resolvedWallet, isWalletQuery } = await lookupByDeployerOrFee(
        rest,
        "both",
        "newest",
        { bankrApiKey: pickTelegramBankrApiKeyRoundRobin() }
      );
      if (!matches.length) {
        const link = searchUrl ?? `https://bankr.bot/launches/search?q=${encodeURIComponent(normalized || rest)}`;
        const lines = [
          "No Bankr tokens matched this lookup.",
          "",
          `Open Bankr search: ${link}`,
        ];
        if (!isWalletQuery && normalized && !resolvedWallet) {
          lines.push(
            "",
            `Could not resolve a wallet for @${normalized} from Bankr alone. We only know wallets when that X/Farcaster appears as deployer or fee recipient on a Bankr launch (or Bankr’s simulate step resolves it).`,
            "If they have no tokens on Bankr yet, search may still be empty — try their 0x… address if you have it."
          );
        } else if (!isWalletQuery && normalized && resolvedWallet) {
          lines.push("", `Resolved wallet: ${resolvedWallet} (no deployed tokens matched in our merged list).`);
        }
        return send(lines.join("\n"));
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
    if (!rest) return send("Usage: /token <0x…ba3 or Bankr launch URL>");
    const m = rest.match(/0x[a-fA-F0-9]{40}/);
    const addr = m ? m[0].toLowerCase() : null;
    if (!addr || !isBankrTokenAddress(addr)) {
      return send("Need a Bankr token address (0x…ba3) or URL containing it.");
    }
    await runTokenLookupForChat(send, addr, pickTelegramBankrApiKeyRoundRobin());
    return;
  }

  await send("Unknown command. Try /help");
}
