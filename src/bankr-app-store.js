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

function normalizeWatchlist(watchlist) {
  const w = { ...DEFAULT_WATCHLIST, ...(watchlist || {}) };
  return {
    x: normalizeStringList(w.x).map((v) => v.replace(/^@/, "")),
    fc: normalizeStringList(w.fc),
    wallet: normalizeStringList(w.wallet).filter((v) => /^0x[a-f0-9]{40}$/.test(v)),
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

function sanitizeUser(userId, raw = {}) {
  const now = new Date().toISOString();
  return {
    userId,
    walletAddress: raw.walletAddress || userId,
    destinations: normalizeDestinations(raw.destinations),
    watchlist: normalizeWatchlist(raw.watchlist),
    settings: normalizeSettings(raw.settings),
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
    return { ok: true, user };
  });
}

export async function listActiveBankrAppUsers() {
  const users = await loadAll();
  return Object.values(users).filter((u) => {
    const hasDestination = !!(u.destinations?.discordWebhookUrl || u.destinations?.telegramChatId);
    const hasWatch = Object.values(u.watchlist || {}).some((arr) => Array.isArray(arr) && arr.length > 0);
    const wantsBroadcast = u.settings?.hot === true || u.settings?.trending !== false;
    return hasDestination && (hasWatch || wantsBroadcast);
  });
}

export async function hasActiveBankrAppUsers() {
  const users = await listActiveBankrAppUsers();
  return users.length > 0;
}

export function bankrAppUserToWatchListSets(user) {
  const w = user?.watchlist || DEFAULT_WATCHLIST;
  return {
    x: new Set(normalizeWatchlist(w).x),
    fc: new Set(normalizeWatchlist(w).fc),
    wallet: new Set(normalizeWatchlist(w).wallet),
    keywords: new Set(normalizeWatchlist(w).keywords),
    tokenAddresses: new Set(normalizeWatchlist(w).tokenAddresses),
  };
}

export function bankrAppAlertsEnabled() {
  const v = String(process.env.BANKR_APP_ALERTS_ENABLED ?? "true").toLowerCase();
  return v !== "false" && v !== "0" && v !== "off";
}

