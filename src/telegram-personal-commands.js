/**
 * Commands for Telegram private chat (personal DM bot layer).
 */

import {
  resolveHandleToWallet,
  parseQuery,
  lookupByDeployerOrFee,
  launchWallet,
  getBankrWalletLaunchRoleCounts,
} from "./lookup-deployer.js";
import { fetchIndexerTradingSnapshot } from "./token-trend-card.js";
import {
  buildTokenDetailTelegramHtml,
  buildPasteTokenFeesTelegramHtml,
  buildTelegramTradeKeyboardMarkup,
  getDeployerFeedCount,
  getFeeRecipientFeedCount,
} from "./notify.js";
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
  addPersonalActivityWatch,
  removePersonalActivityWatch,
  TELEGRAM_PERSONAL_WATCHLIST_MAX,
} from "./telegram-personal-store.js";
import { summarizeActivityWatchThresholds } from "./activity-watch.js";
import { hasTelegramBankrApiKeys, pickTelegramBankrApiKeyRoundRobin } from "./telegram-bankr-keys.js";
import { resolveCashtagToBankrToken, formatCashtagResolvePreambleHtml } from "./cashtag-resolve.js";

/** Max token rows per /lookup reply (Telegram ~4k limit). */
const TELEGRAM_LOOKUP_MAX_ROWS = Math.min(Math.max(parseInt(process.env.TELEGRAM_LOOKUP_MAX_ROWS || "15", 10), 5), 35);

function normalizeThresholdToken(raw) {
  if (raw == null) return "";
  return String(raw).replace(/,/g, "").trim();
}

function parsePositiveInt(raw) {
  const s = normalizeThresholdToken(raw);
  const n = Math.trunc(Number(s));
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

/** Keys we accept before a separate value token: mcap 30000, b1h 30, cd 15 */
const ACTIVITY_SPACE_KEYS = new Set([
  "mcap",
  "mcap_usd_min",
  "b15",
  "buys_15m",
  "min_buys_15m",
  "s15",
  "sells_15m",
  "min_sells_15m",
  "sw15",
  "swaps_15m",
  "min_swaps_15m",
  "b1h",
  "buys_1h",
  "min_buys_1h",
  "s1h",
  "sells_1h",
  "min_sells_1h",
  "b24",
  "buys_24h",
  "min_buys_24h",
  "s24",
  "sells_24h",
  "min_sells_24h",
  "tr24",
  "trades_24h",
  "min_trades_24h",
  "cd",
  "cooldown",
  "cooldown_minutes",
]);

/**
 * Token + thresholds: `0x…ba3 mcap=50000`, `mcap 30,000`, `b1h 30`, `cd 15` (cd = minutes).
 * Finds first 40-hex address (incl. inside URL).
 */
function parseActivityAddRest(rest) {
  const t = String(rest || "").trim();
  const m = t.match(/0x[a-fA-F0-9]{40}/i);
  const addr = m ? m[0].toLowerCase() : null;
  const withoutAddr = m ? t.replace(m[0], " ").replace(/\s+/g, " ").trim() : t;
  const tokens = withoutAddr.split(/\s+/).filter(Boolean);
  const kv = {};
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const eq = tok.indexOf("=");
    if (eq > 0) {
      kv[tok.slice(0, eq).toLowerCase()] = normalizeThresholdToken(tok.slice(eq + 1));
      continue;
    }
    const col = tok.indexOf(":");
    if (col > 0 && col < tok.length - 1) {
      kv[tok.slice(0, col).toLowerCase()] = normalizeThresholdToken(tok.slice(col + 1));
      continue;
    }
    const key = tok.replace(/:$/, "").toLowerCase();
    if (ACTIVITY_SPACE_KEYS.has(key) && i + 1 < tokens.length) {
      kv[key] = normalizeThresholdToken(tokens[i + 1]);
      i++;
    }
  }
  return { addr, kv };
}

function buildActivityRuleFromKv(kv) {
  const pickInt = (...keys) => {
    for (const k of keys) {
      const raw = kv[k];
      if (raw == null || raw === "") continue;
      const n = parsePositiveInt(raw);
      if (n != null) return n;
    }
    return null;
  };
  const rule = {
    mcapUsdMin: pickInt("mcap", "mcap_usd_min"),
    minBuys15m: pickInt("b15", "buys_15m", "min_buys_15m"),
    minSells15m: pickInt("s15", "sells_15m", "min_sells_15m"),
    minSwaps15m: pickInt("sw15", "swaps_15m", "min_swaps_15m"),
    minBuys1h: pickInt("b1h", "buys_1h", "min_buys_1h"),
    minSells1h: pickInt("s1h", "sells_1h", "min_sells_1h"),
    minBuys24h: pickInt("b24", "buys_24h", "min_buys_24h"),
    minSells24h: pickInt("s24", "sells_24h", "min_sells_24h"),
    minTrades24h: pickInt("tr24", "trades_24h", "min_trades_24h"),
  };
  const cdMin = pickInt("cd", "cooldown", "cooldown_minutes");
  if (cdMin != null) rule.cooldownSec = Math.min(1440, cdMin) * 60;
  return rule;
}

/** Strip @BotName suffix from /command@bot */
function parseCommandLine(text) {
  const trimmed = String(text || "").trim();
  const first = trimmed.split(/\s+/)[0] || "";
  const cmd = (first.split("@")[0] || "").toLowerCase();
  const rest = trimmed.slice(first.length).trim();
  return { cmd, rest, trimmed };
}

/** Optional first token: deployer | fee | both — rest is the query (wallet, @handle, URL). */
export function parseLookupCommandRest(rest) {
  const t = String(rest || "").trim();
  if (!t) return { filter: "both", query: "" };
  const parts = t.split(/\s+/);
  const first = parts[0].toLowerCase();
  if (["deployer", "fee", "both"].includes(first) && parts.length >= 2) {
    return { filter: first, query: parts.slice(1).join(" ").trim() };
  }
  return { filter: "both", query: t };
}

/**
 * @param {(msg: string) => Promise<void>} send
 * @param {Awaited<ReturnType<typeof lookupByDeployerOrFee>>} out
 * @param {"both"|"deployer"|"fee"} [filterMode]
 */
export async function sendTelegramTokenLookupResult(send, out, filterMode = "both") {
  const { matches, totalCount, searchUrl, normalized, resolvedWallet, isWalletQuery } = out;
  const filterNote = filterMode !== "both" ? ` · ${filterMode}` : "";

  if (!matches.length) {
    const link = searchUrl ?? `https://bankr.bot/launches/search?q=${encodeURIComponent(normalized || "")}`;
    const lines = [];
    lines.push(`**Lookup**${filterNote}`);
    if (resolvedWallet && !isWalletQuery) {
      lines.push(`Wallet: \`${resolvedWallet}\``);
    }
    lines.push("", "No Bankr tokens matched.", "", `Bankr search: ${link}`);
    if (!isWalletQuery && normalized && resolvedWallet) {
      lines.push("", "The site may still list more for this wallet.");
    } else if (!isWalletQuery && normalized && !resolvedWallet) {
      lines.push("", "Try the link above or a **0x…** address.");
    }
    await send(lines.join("\n"));
    return;
  }

  const shown = matches.slice(0, TELEGRAM_LOOKUP_MAX_ROWS);
  const lines = [`**Lookup**${filterNote}`];
  if (resolvedWallet && !isWalletQuery) {
    lines.push(`Wallet: \`${resolvedWallet}\``);
  } else if (isWalletQuery && normalized) {
    lines.push(`Wallet: \`${normalized}\``);
  }
  lines.push("", `Tokens (${totalCount || matches.length}):`, "");
  for (const m of shown) {
    lines.push(`• $${m.tokenSymbol} · ${m.tokenAddress} · ${m.bankrUrl}`);
  }
  if (matches.length > shown.length) {
    lines.push("", `…+${matches.length - shown.length} more on Bankr`);
  }
  lines.push("", `Full search: ${searchUrl ?? `https://bankr.bot/launches/search?q=${encodeURIComponent(resolvedWallet ?? normalized ?? "")}`}`);
  await send(lines.join("\n"));
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

/**
 * Same enrichment as Discord paste (indexer snapshot + feed / Bankr role counts).
 * @param {Awaited<ReturnType<typeof getTokenFees>>} out
 * @param {string} [bankrApiKey]
 */
export async function buildTelegramTokenDetailOptions(out, bankrApiKey) {
  const tokenAddress = out.tokenAddress;
  if (!tokenAddress) return {};
  const deployWallet = out.launch ? launchWallet(out.launch, "deployer") : null;
  const [indexerSnap, deployFeedN, feeFeedN, bankrRole] = await Promise.all([
    fetchIndexerTradingSnapshot(tokenAddress).catch(() => null),
    deployWallet ? getDeployerFeedCount(deployWallet).catch(() => null) : Promise.resolve(null),
    out.feeWallet ? getFeeRecipientFeedCount(out.feeWallet).catch(() => null) : Promise.resolve(null),
    (async () => {
      if (!bankrApiKey) return { bankrDeploy: null, bankrFee: null };
      const d = deployWallet?.toLowerCase() ?? null;
      const f = out.feeWallet?.toLowerCase() ?? null;
      try {
        if (d && f && d === f) {
          const c = await getBankrWalletLaunchRoleCounts(d, { bankrApiKey });
          return { bankrDeploy: c.asDeployer ?? null, bankrFee: c.asFeeRecipient ?? null };
        }
        const [cDep, cFee] = await Promise.all([
          d ? getBankrWalletLaunchRoleCounts(d, { bankrApiKey }).catch(() => null) : null,
          f && f !== d ? getBankrWalletLaunchRoleCounts(f, { bankrApiKey }).catch(() => null) : null,
        ]);
        return {
          bankrDeploy: cDep?.asDeployer ?? null,
          bankrFee: f && f !== d ? cFee?.asFeeRecipient ?? null : null,
        };
      } catch {
        return { bankrDeploy: null, bankrFee: null };
      }
    })(),
  ]);
  const feedCountOpts = {};
  if (bankrRole.bankrDeploy != null) feedCountOpts.bankrDeployCount = bankrRole.bankrDeploy;
  else if (deployFeedN != null && deployFeedN >= 1) feedCountOpts.deployerFeedCount = deployFeedN;
  if (bankrRole.bankrFee != null) feedCountOpts.bankrFeeRecipientCount = bankrRole.bankrFee;
  else if (feeFeedN != null && feeFeedN >= 1) feedCountOpts.feeRecipientFeedCount = feeFeedN;
  return { ...feedCountOpts, indexerSnapshot: indexerSnap };
}

/** Discord-parity token card for Telegram (HTML + GMGN / BB / Sigma buttons). */
export async function sendTelegramTokenDetailReply(send, out, tokenAddress, bankrApiKey) {
  const opts = await buildTelegramTokenDetailOptions(out, bankrApiKey);
  let html = buildTokenDetailTelegramHtml(out, tokenAddress, opts);
  const feesHtml = buildPasteTokenFeesTelegramHtml(out);
  if (feesHtml) html += "\n\n" + feesHtml;
  const keyboard = buildTelegramTradeKeyboardMarkup(tokenAddress);
  await send(html, { parse_mode: "HTML", reply_markup: keyboard ?? undefined });
}

/**
 * @param {(msg: string, opts?: object) => Promise<void>} send
 * @param {string} addr
 * @param {string} bankrApiKey
 * @param {{ preambleHtml?: string }} [opts]
 */
export async function runTokenLookupForChat(send, addr, bankrApiKey, opts = {}) {
  const tokenAddress = addr.toLowerCase();
  if (!isBankrTokenAddress(tokenAddress)) {
    await send("Need a Bankr token address (0x…ba3) or Bankr launch URL.");
    return;
  }
  const fetchLine = opts.preambleHtml
    ? `${opts.preambleHtml}\n\nFetching token…`
    : "Fetching token…";
  await send(fetchLine, opts.preambleHtml ? { parse_mode: "HTML" } : undefined);
  try {
    const out = await getTokenFees(tokenAddress, { bankrApiKey });
    await sendTelegramTokenDetailReply(send, out, tokenAddress, bankrApiKey);
  } catch (e) {
    await send(`Token lookup failed: ${e.message}`);
  }
}

/** Shared wallet-resolve command (DMs + groups). */
export async function runTelegramWalletLookupCommand(send, rest) {
  if (!rest?.trim()) {
    await send("Usage: /walletlookup <0x | @handle | profile URL>");
    return;
  }
  if (!hasTelegramBankrApiKeys()) {
    await send("Set TELEGRAM_BANKR_API_KEYS or BANKR_API_KEY on the bot for wallet lookup.");
    return;
  }
  await send("Resolving…");
  try {
    const { wallet, normalized, isWallet } = await resolveHandleToWallet(rest, {
      bankrApiKey: pickTelegramBankrApiKeyRoundRobin(),
    });
    if (wallet) {
      await send(
        (isWallet ? `Wallet: \`${wallet}\`\n\n` : `Wallet for ${normalized}: \`${wallet}\`\n\n`) +
          "Use **/lookup** with the same handle or wallet to see Bankr tokens (deployer / fee recipient)."
      );
    } else {
      await send(
        `Could not resolve a wallet for **${normalized || rest}**. Try **/lookup** for a full search, or paste a **0x…** address.`
      );
    }
  } catch (e) {
    await send(`Resolve failed: ${e.message}`);
  }
}

/** Shared deployer/fee lookup command (DMs + groups). */
export async function runTelegramLookupCommand(send, rest) {
  const { filter, query } = parseLookupCommandRest(rest);
  if (!query) {
    await send(
      "Usage: /lookup [deployer|fee|both] <0x | @handle | X/Farcaster URL>\nExample: `/lookup https://x.com/user` or `/lookup fee 0x…`"
    );
    return;
  }
  if (!hasTelegramBankrApiKeys()) {
    await send("Set TELEGRAM_BANKR_API_KEYS or BANKR_API_KEY for lookups.");
    return;
  }
  await send("Looking up tokens…");
  try {
    const out = await lookupByDeployerOrFee(query, filter, "newest", {
      bankrApiKey: pickTelegramBankrApiKeyRoundRobin(),
    });
    await sendTelegramTokenLookupResult(send, out, filter);
  } catch (e) {
    await send(`Lookup failed: ${e.message}`);
  }
}

/** Shared /token command (DMs + groups). */
export async function runTelegramTokenSlashCommand(send, rest) {
  if (!rest?.trim()) {
    await send("Usage: /token <0x…ba3 | $TICKER | Bankr launch URL>");
    return;
  }
  if (!hasTelegramBankrApiKeys()) {
    await send("Set TELEGRAM_BANKR_API_KEYS or BANKR_API_KEY for token lookup.");
    return;
  }
  const trimmed = rest.trim();
  const cashtagOnly = trimmed.match(/^\$([A-Za-z0-9_]{2,15})$/);
  if (cashtagOnly && !/0x[a-fA-F0-9]{40}/i.test(trimmed)) {
    const resolved = await resolveCashtagToBankrToken(cashtagOnly[1]);
    if (!resolved) {
      await send(
        `No Bankr token on this chain matched $${cashtagOnly[1].toUpperCase()} (or below liquidity/volume floors). Try a \`0x…ba3\` address.`
      );
      return;
    }
    await runTokenLookupForChat(send, resolved.address, pickTelegramBankrApiKeyRoundRobin(), {
      preambleHtml: formatCashtagResolvePreambleHtml(resolved),
    });
    return;
  }
  const m = rest.match(/0x[a-fA-F0-9]{40}/);
  const addr = m ? m[0].toLowerCase() : null;
  if (!addr || !isBankrTokenAddress(addr)) {
    await send("Need a Bankr token address (0x…ba3), `$TICKER`, or URL containing the CA.");
    return;
  }
  await runTokenLookupForChat(send, addr, pickTelegramBankrApiKeyRoundRobin());
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

  if (cmd === "/activity") {
    await registerPersonalUser(chatId);
    const tail = rest.trim();
    const parts = tail.split(/\s+/).filter(Boolean);
    const first = (parts[0] || "").toLowerCase();

    if (!tail || first === "help") {
      await send(
        [
          "<b>Activity watch</b> — 1 of your 5 watch items; DMs when thresholds hit.",
          "",
          "<b>Easiest:</b> paste token + numbers (spaces OK, commas OK):",
          "<code>/activity 0x…ba3 mcap 30000</code>",
          "<code>/activity 0x…ba3 mcap 30,000 b1h 30 cd 20</code>",
          "",
          "Keys: <code>mcap</code> (USD), <code>b15</code> <code>s15</code> <code>sw15</code>, <code>b1h</code> <code>s1h</code>, <code>b24</code> <code>s24</code> <code>tr24</code>, <code>cd</code> (minutes between alerts, default 15).",
          "Also works: <code>mcap=30000</code> or <code>/activity add 0x… …</code>",
          "",
          "<code>/activity list</code> · <code>/activity remove 0x…ba3</code>",
          "",
          "<i>Same as Discord /activity-watch (Doppler). 15m/1h = swap sample.</i>",
        ].join("\n"),
        { parse_mode: "HTML" }
      );
      return;
    }

    if (first === "list") {
      const u = await getPersonalUser(chatId);
      const act = (u?.watchlist || []).filter((e) => e.type === "activity" && e.activity);
      if (act.length === 0) {
        await send("No activity watches. Example: /activity 0x…ba3 mcap 25000");
        return;
      }
      const lines = act.map((e) => {
        const summ = summarizeActivityWatchThresholds(e.activity);
        const cd = Math.round(e.activity.cooldownSec / 60);
        return `• <code>${e.value}</code>\n  ${summ} · cd ${cd}m`;
      });
      await send(`<b>Activity watches</b> (${act.length})\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
      return;
    }

    if (first === "remove") {
      const subRest = parts.slice(1).join(" ").trim();
      const m = subRest.match(/0x[a-fA-F0-9]{40}/i);
      if (!m) {
        await send("Usage: /activity remove <0x…ba3>");
        return;
      }
      const r = await removePersonalActivityWatch(chatId, m[0]);
      await send(r.ok ? "Removed activity watch for that token." : "No activity rule for that token.");
      return;
    }

    let addPayload = "";
    if (first === "add") {
      addPayload = parts.slice(1).join(" ").trim();
    } else if (/^0x[a-fA-F0-9]{40}$/i.test(parts[0] || "") || /0x[a-fA-F0-9]{40}/i.test(tail)) {
      addPayload = tail;
    } else {
      await send(
        "Send the token first, then thresholds — no need for <code>add</code>:\n<code>/activity 0x…ba3 mcap 30000</code>\nOr: <code>/activity list</code> · <code>/activity help</code>",
        { parse_mode: "HTML" }
      );
      return;
    }

    if (!addPayload) {
      await send("Example: <code>/activity 0x…ba3 mcap 50000 b1h 20</code>", { parse_mode: "HTML" });
      return;
    }

    const { addr, kv } = parseActivityAddRest(addPayload);
    if (!addr || !isBankrTokenAddress(addr)) {
      await send("Need a Bankr token (0x…ba3) or a Bankr URL that contains it, plus at least one threshold.");
      return;
    }
    const rule = buildActivityRuleFromKv(kv);
    const r = await addPersonalActivityWatch(chatId, addr, rule);
    if (!r.ok) {
      if (r.error === "LIMIT") {
        return send(`Max ${TELEGRAM_PERSONAL_WATCHLIST_MAX} watch items. Remove one with /remove or /activity remove.`);
      }
      if (r.error === "DUPLICATE_ACTIVITY") {
        return send("You already have an activity watch for this token. /activity remove <0x…> first.");
      }
      if (r.error === "NO_THRESHOLDS") {
        return send("Add at least one number: e.g. mcap 30000 or b1h 30 (spaces and commas OK).");
      }
      if (r.error === "BAD_TOKEN") {
        return send("Invalid token — use a Bankr address (0x…ba3).");
      }
      return send("Could not add activity watch.");
    }
    const a = r.user?.watchlist?.find((x) => x.type === "activity" && x.value === addr)?.activity;
    const summ = a ? summarizeActivityWatchThresholds(a) : "";
    const cd = a ? Math.round(a.cooldownSec / 60) : 15;
    return send(`Added activity watch.\n${addr}\n${summ}\nCooldown: ${cd} min\n\nPoll uses ACTIVITY_WATCH_POLL_MS (same as Discord).`);
  }

  // Lone $TICKER in a DM → resolve to Bankr token (highest mcap on indexer) then fee card
  const loneCashtag = trimmed.match(/^\$([A-Za-z0-9_]{2,15})$/);
  if (loneCashtag) {
    if (!hasTelegramBankrApiKeys()) {
      return send("Set TELEGRAM_BANKR_API_KEYS or BANKR_API_KEY on the bot for token lookup.");
    }
    const resolved = await resolveCashtagToBankrToken(loneCashtag[1]);
    if (!resolved) {
      return send(
        `No Bankr token on this chain matched $${loneCashtag[1].toUpperCase()} (or below liquidity/volume floors). Paste a \`0x…ba3\` address.`
      );
    }
    await runTokenLookupForChat(send, resolved.address, pickTelegramBankrApiKeyRoundRobin(), {
      preambleHtml: formatCashtagResolvePreambleHtml(resolved),
    });
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
        "/walletlookup <0x | @handle | URL> — resolve X/Farcaster to wallet only",
        "/lookup [deployer|fee|both] <0x | @handle | URL> — Bankr tokens for that wallet or account",
        "/token <0x…ba3 | $TICKER | Bankr launch URL>",
        "/activity <0x…ba3> mcap 30000 — threshold DMs (1 slot; /activity help)",
        "",
        `Max ${TELEGRAM_PERSONAL_WATCHLIST_MAX} watch items (wallet, keyword, token, or activity).`,
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
    const lines = list.map((e) => {
      if (e.type === "activity" && e.activity) {
        const summ = summarizeActivityWatchThresholds(e.activity);
        const cd = Math.round(e.activity.cooldownSec / 60);
        return `• activity: ${e.value}\n  ${summ} · cd ${cd}m`;
      }
      return `• ${e.type}: ${e.value}`;
    });
    return send(lines.join("\n\n"));
  }

  if (cmd === "/walletlookup" || cmd === "/wallet") {
    return runTelegramWalletLookupCommand(send, rest);
  }

  if (cmd === "/lookup") {
    return runTelegramLookupCommand(send, rest);
  }

  if (cmd === "/token") {
    return runTelegramTokenSlashCommand(send, rest);
  }

  await send("Unknown command. Try /help");
}
