/**
 * Per-Bankr-App-user config.
 *
 * The Bankr App uses ctx.caller.walletAddress as the account key and talks to
 * the Railway bot through the secured config API. Alerts still run in the bot.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { randomBytes } from "crypto";

const FILE = process.env.BANKR_APP_USERS_FILE || join(process.cwd(), ".bankr-app-users.json");
const CONNECT_CODES_FILE = process.env.BANKR_APP_CONNECT_CODES_FILE || join(dirname(FILE), ".bankr-app-connect-codes.json");
const TELEGRAM_CONNECT_CODE_TTL_MS = Math.max(
  60_000,
  parseInt(process.env.BANKR_APP_TELEGRAM_CONNECT_CODE_TTL_MS || "900000", 10)
);

const DEFAULT_WATCHLIST = {
  x: [],
  fc: [],
  wallet: [],
  keywords: [],
  tokenAddresses: [],
};

const DEFAULT_DESTINATIONS = {
  discordWebhookUrl: null,
  telegramChatId: null,
};

const DEFAULT_SETTINGS = {
  launchAlerts: true,
  hot: false,
  trending: true,
  claimAlerts: false,
  telegramDms: true,
};

const DEFAULT_AUTO_TRADE = {
  enabled: false,
  amountUsdc: 1,
  takeProfitPct: 50,
  stopLossPct: 20,
};

let _chain = Promise.resolve();

function queue(fn) {
  _chain = _chain.then(fn, fn);
  return _chain;
}

function normalizeUserId(walletAddress) {
  const s = String(walletAddress ?? "").trim();
  if (!s) return null;
  return /^0x[a-fA-F0-9]{40}$/.test(s) ? s.toLowerCase() : s.toLowerCase();
}

function normalizeStringList(value, { lower = true, max = 100 } = {}) {
  const arr = Array.isArray(value) ? value : [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const raw = typeof item === "object" && item !== null ? item.value : item;
    let s = String(raw ?? "").trim();
    if (!s) continue;
    if (lower) s = s.toLowerCase();
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeWalletEntries(value, { max = 100 } = {}) {
  const arr = Array.isArray(value) ? value : [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const rawValue = typeof item === "object" && item !== null ? item.value : item;
    const wallet = String(rawValue ?? "").trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(wallet) || seen.has(wallet)) continue;
    seen.add(wallet);
    const rawName = typeof item === "object" && item !== null ? item.name : null;
    const name = rawName != null && String(rawName).trim() ? String(rawName).trim().slice(0, 80) : null;
    out.push(name ? { value: wallet, name } : { value: wallet });
    if (out.length >= max) break;
  }
  return out;
}

function normalizeWatchlist(watchlist) {
  const w = { ...DEFAULT_WATCHLIST, ...(watchlist || {}) };
  return {
    x: normalizeStringList(w.x).map((v) => v.replace(/^@/, "")),
    fc: normalizeStringList(w.fc),
    wallet: normalizeWalletEntries(w.wallet),
    keywords: normalizeStringList(w.keywords, { lower: true, max: 200 }),
    tokenAddresses: normalizeStringList(w.tokenAddresses).filter((v) => /^0x[a-f0-9]{40}$/.test(v)),
  };
}

function normalizeDiscordWebhookUrl(value) {
  const s = String(value ?? "").trim();
  if (!s) return null;
  if (!/^https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/\d+\/[\w-]+/i.test(s)) return null;
  return s;
}

function normalizeDestinations(destinations) {
  const d = { ...DEFAULT_DESTINATIONS, ...(destinations || {}) };
  return {
    discordWebhookUrl: normalizeDiscordWebhookUrl(d.discordWebhookUrl),
    telegramChatId: d.telegramChatId != null && String(d.telegramChatId).trim() ? String(d.telegramChatId).trim() : null,
    telegramUsername: d.telegramUsername != null && String(d.telegramUsername).trim() ? String(d.telegramUsername).replace(/^@/, "").trim() : null,
    telegramFirstName: d.telegramFirstName != null && String(d.telegramFirstName).trim() ? String(d.telegramFirstName).trim() : null,
  };
}

function normalizeSettings(settings) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  return {
    launchAlerts: s.launchAlerts !== false,
    hot: s.hot === true,
    trending: s.trending !== false,
    claimAlerts: s.claimAlerts === true,
    telegramDms: s.telegramDms !== false,
  };
}

function normalizeAutoTrade(autoTrade) {
  const s = { ...DEFAULT_AUTO_TRADE, ...(autoTrade || {}) };
  const amount = Number(s.amountUsdc);
  const tp = Number(s.takeProfitPct);
  const sl = Number(s.stopLossPct);
  return {
    enabled: s.enabled === true,
    amountUsdc: Number.isFinite(amount) ? Math.min(10_000, Math.max(0.01, amount)) : DEFAULT_AUTO_TRADE.amountUsdc,
    takeProfitPct: Number.isFinite(tp) ? Math.min(1000, Math.max(1, tp)) : DEFAULT_AUTO_TRADE.takeProfitPct,
    stopLossPct: Number.isFinite(sl) ? Math.min(99, Math.max(1, sl)) : DEFAULT_AUTO_TRADE.stopLossPct,
  };
}

function normalizePendingTradeField(value) {
  if (value == null) return null;
  if (typeof value === "object" && Object.keys(value).length === 0) return null;
  const tokenAddress = normAddr(value.tokenAddress);
  if (!tokenAddress) return null;
  return {
    id: String(value.id || `pt-${tokenAddress.slice(2, 10)}`),
    status: String(value.status || "pending").slice(0, 32),
    tokenAddress,
    name: value.name != null ? String(value.name).slice(0, 120) : null,
    symbol: value.symbol != null ? String(value.symbol).slice(0, 32) : null,
    amountUsdc: value.amountUsdc != null ? Number(value.amountUsdc) : null,
    takeProfitPct: value.takeProfitPct != null ? Number(value.takeProfitPct) : null,
    stopLossPct: value.stopLossPct != null ? Number(value.stopLossPct) : null,
    bankrUrl: value.bankrUrl || `https://bankr.bot/launches/${tokenAddress}`,
    marketCapFormatted: value.marketCapFormatted ?? null,
    buys30m: value.buys30m ?? null,
    buys5m: value.buys5m ?? null,
    buys1h: value.buys1h ?? null,
    createdAt: value.createdAt || null,
    createdAtMs: value.createdAtMs != null ? Number(value.createdAtMs) : null,
    clearedAt: value.clearedAt || null,
  };
}

function normalizeAutoTradePositions(value) {
  const arr = Array.isArray(value) ? value : [];
  return arr
    .filter((p) => p && normAddr(p.tokenAddress))
    .slice(0, 50)
    .map((p) => ({
      id: String(p.id || `pos-${p.tokenAddress?.slice(2, 10)}`),
      tokenAddress: normAddr(p.tokenAddress),
      name: p.name != null ? String(p.name).slice(0, 120) : null,
      symbol: p.symbol != null ? String(p.symbol).slice(0, 32) : null,
      status: String(p.status || "open").slice(0, 32),
      boughtAt: p.boughtAt || null,
      closedAt: p.closedAt || null,
      entryMcap: p.entryMcap != null ? Number(p.entryMcap) : null,
      takeProfitPct: p.takeProfitPct != null ? Number(p.takeProfitPct) : null,
      stopLossPct: p.stopLossPct != null ? Number(p.stopLossPct) : null,
      amountUsdc: p.amountUsdc != null ? Number(p.amountUsdc) : null,
      buyJobId: p.buyJobId || null,
      sellJobId: p.sellJobId || null,
      sellReason: p.sellReason || null,
      exitChangePct: p.exitChangePct != null ? Number(p.exitChangePct) : null,
      lastError: p.lastError != null ? String(p.lastError).slice(0, 500) : null,
    }));
}

function normAddr(addr) {
  const s = String(addr ?? "").trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(s) ? s : null;
}

/** Strip secrets before sending config to the Bankr App. */
export function bankrAppUserForClient(user) {
  if (!user) return user;
  const auto = user.autoTrade;
  const pending = user.pendingTrade;
  return {
    ...user,
    autoTrade: auto
      ? {
          enabled: auto.enabled,
          amountUsdc: auto.amountUsdc,
          takeProfitPct: auto.takeProfitPct,
          stopLossPct: auto.stopLossPct,
        }
      : {
          enabled: false,
          amountUsdc: DEFAULT_AUTO_TRADE.amountUsdc,
          takeProfitPct: DEFAULT_AUTO_TRADE.takeProfitPct,
          stopLossPct: DEFAULT_AUTO_TRADE.stopLossPct,
        },
    pendingTrade:
      pending && pending.status === "pending" && pending.tokenAddress
        ? {
            id: pending.id,
            tokenAddress: pending.tokenAddress,
            name: pending.name,
            symbol: pending.symbol,
            amountUsdc: pending.amountUsdc,
            bankrUrl: pending.bankrUrl,
            createdAt: pending.createdAt,
          }
        : null,
    autoTradePositions: user.autoTradePositions || [],
  };
}

function sanitizeUser(userId, raw = {}) {
  const now = new Date().toISOString();
  const existingAuto = raw.autoTrade || {};
  return {
    userId,
    walletAddress: raw.walletAddress || userId,
    destinations: normalizeDestinations(raw.destinations),
    watchlist: normalizeWatchlist(raw.watchlist),
    settings: normalizeSettings(raw.settings),
    autoTrade: normalizeAutoTrade(existingAuto),
    pendingTrade: normalizePendingTradeField(raw.pendingTrade),
    autoTradePositions: normalizeAutoTradePositions(raw.autoTradePositions),
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || now,
  };
}

async function loadAll() {
  try {
    const raw = await readFile(FILE, "utf-8");
    const j = JSON.parse(raw);
    const users = j?.users;
    if (!users || typeof users !== "object" || Array.isArray(users)) return {};
    const out = {};
    for (const [id, user] of Object.entries(users)) {
      const userId = normalizeUserId(id);
      if (!userId) continue;
      out[userId] = sanitizeUser(userId, user);
    }
    return out;
  } catch {
    return {};
  }
}

async function saveAll(users) {
  await mkdir(dirname(FILE), { recursive: true }).catch(() => {});
  await writeFile(FILE, JSON.stringify({ users }, null, 2), "utf-8");
}

async function loadConnectCodes() {
  try {
    const raw = await readFile(CONNECT_CODES_FILE, "utf-8");
    const j = JSON.parse(raw);
    return j && typeof j === "object" && typeof j.codes === "object" && j.codes !== null ? j.codes : {};
  } catch {
    return {};
  }
}

async function saveConnectCodes(codes) {
  await mkdir(dirname(CONNECT_CODES_FILE), { recursive: true }).catch(() => {});
  await writeFile(CONNECT_CODES_FILE, JSON.stringify({ codes }, null, 2), "utf-8");
}

function makeConnectCode() {
  // Uppercase, no ambiguous punctuation. 6 chars gives enough entropy for short-lived one-time pairing.
  return randomBytes(5).toString("base64url").replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toUpperCase();
}

function telegramBotUrlForCode(code) {
  const username = String(process.env.TELEGRAM_BOT_USERNAME || "").trim().replace(/^@/, "");
  if (!username) return null;
  return `https://t.me/${encodeURIComponent(username)}?start=connect_${encodeURIComponent(code)}`;
}

export async function getBankrAppUser(walletAddress) {
  const userId = normalizeUserId(walletAddress);
  if (!userId) return null;
  const users = await loadAll();
  return users[userId] ?? sanitizeUser(userId, { walletAddress: userId });
}

export async function setBankrAppUserConfig(walletAddress, updates = {}) {
  const userId = normalizeUserId(walletAddress);
  if (!userId) return null;
  return queue(async () => {
    const users = await loadAll();
    const existing = users[userId] ?? sanitizeUser(userId, { walletAddress: userId });
    const next = sanitizeUser(userId, {
      ...existing,
      walletAddress: existing.walletAddress || userId,
      destinations:
        updates.destinations !== undefined
          ? { ...existing.destinations, ...updates.destinations }
          : existing.destinations,
      watchlist:
        updates.watchlist !== undefined
          ? { ...existing.watchlist, ...updates.watchlist }
          : existing.watchlist,
      settings:
        updates.settings !== undefined
          ? { ...existing.settings, ...updates.settings }
          : existing.settings,
      autoTrade:
        updates.autoTrade !== undefined
          ? normalizeAutoTrade({ ...existing.autoTrade, ...updates.autoTrade })
          : existing.autoTrade,
      pendingTrade:
        updates.pendingTrade !== undefined
          ? normalizePendingTradeField(updates.pendingTrade)
          : existing.pendingTrade,
      autoTradePositions:
        updates.autoTradePositions !== undefined ? updates.autoTradePositions : existing.autoTradePositions,
      updatedAt: new Date().toISOString(),
    });
    users[userId] = next;
    await saveAll(users);
    return next;
  });
}

export async function createTelegramConnectCode(walletAddress) {
  const userId = normalizeUserId(walletAddress);
  if (!userId) return null;
  return queue(async () => {
    const codes = await loadConnectCodes();
    const now = Date.now();
    for (const [code, entry] of Object.entries(codes)) {
      if (!entry || entry.expiresAtMs <= now || entry.userId === userId) delete codes[code];
    }
    let code = makeConnectCode();
    while (codes[code]) code = makeConnectCode();
    const expiresAtMs = now + TELEGRAM_CONNECT_CODE_TTL_MS;
    codes[code] = {
      code,
      userId,
      walletAddress: userId,
      createdAt: new Date(now).toISOString(),
      expiresAtMs,
    };
    await saveConnectCodes(codes);
    return {
      code,
      command: `/connect ${code}`,
      botUrl: telegramBotUrlForCode(code),
      expiresAt: new Date(expiresAtMs).toISOString(),
      ttlSeconds: Math.floor(TELEGRAM_CONNECT_CODE_TTL_MS / 1000),
    };
  });
}

export async function consumeTelegramConnectCode(codeRaw, telegramChatId, telegramMeta = {}) {
  const code = String(codeRaw ?? "").trim().toUpperCase();
  const chatId = String(telegramChatId ?? "").trim();
  if (!/^[A-Z0-9]{4,12}$/.test(code) || !chatId) return { ok: false, error: "INVALID" };
  return queue(async () => {
    const codes = await loadConnectCodes();
    const entry = codes[code];
    const now = Date.now();
    if (!entry) return { ok: false, error: "NOT_FOUND" };
    delete codes[code];
    await saveConnectCodes(codes);
    if (entry.expiresAtMs <= now) return { ok: false, error: "EXPIRED" };
    const users = await loadAll();
    const existing = users[entry.userId] ?? sanitizeUser(entry.userId, { walletAddress: entry.walletAddress });
    const user = sanitizeUser(entry.userId, {
      ...existing,
      destinations: {
        ...existing.destinations,
        telegramChatId: chatId,
        telegramUsername: telegramMeta.username ? String(telegramMeta.username).replace(/^@/, "") : null,
        telegramFirstName: telegramMeta.firstName ? String(telegramMeta.firstName) : null,
      },
      settings: { ...existing.settings, telegramDms: true },
      updatedAt: new Date().toISOString(),
    });
    users[entry.userId] = user;
    await saveAll(users);
    console.log(
      `[bankr-app] Telegram linked wallet=${entry.userId.slice(0, 6)}...${entry.userId.slice(-4)} chat=${chatId} username=${telegramMeta.username ? `@${telegramMeta.username}` : "none"}`
    );
    return { ok: true, user };
  });
}

export async function listActiveBankrAppUsers() {
  const users = await loadAll();
  return Object.values(users).filter((u) => {
    const hasDestination = !!(u.destinations?.discordWebhookUrl || u.destinations?.telegramChatId);
    const hasWatch = Object.values(u.watchlist || {}).some((arr) => Array.isArray(arr) && arr.length > 0);
    const wantsBroadcast = u.settings?.hot === true || u.settings?.trending !== false;
    const wantsAutoTrade = u.autoTrade?.enabled === true;
    return (hasDestination && (hasWatch || wantsBroadcast)) || wantsAutoTrade;
  });
}

export async function hasActiveBankrAppUsers() {
  const users = await listActiveBankrAppUsers();
  return users.length > 0;
}

export async function listBankrAppAutoTradeUsers() {
  const users = await loadAll();
  return Object.values(users).filter((u) => u.autoTrade?.enabled === true);
}

export function bankrAppUserToWatchListSets(user) {
  const w = user?.watchlist || DEFAULT_WATCHLIST;
  const normalized = normalizeWatchlist(w);
  return {
    x: new Set(normalized.x),
    fc: new Set(normalized.fc),
    wallet: new Set(normalized.wallet.map((entry) => entry.value)),
    keywords: new Set(normalized.keywords),
    tokenAddresses: new Set(normalized.tokenAddresses),
  };
}

export function bankrAppWalletLabelMap(user) {
  const normalized = normalizeWatchlist(user?.watchlist || DEFAULT_WATCHLIST);
  return new Map(normalized.wallet.filter((entry) => entry.name).map((entry) => [entry.value, entry.name]));
}

export function bankrAppAlertsEnabled() {
  const v = String(process.env.BANKR_APP_ALERTS_ENABLED ?? "true").toLowerCase();
  return v !== "false" && v !== "0" && v !== "off";
}

