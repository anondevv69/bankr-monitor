/**
 * Per-user Telegram DM preferences: watchlist (max 5), alert toggles.
 * JSON file — use a Railway volume path for persistence.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";

const FILE = process.env.TELEGRAM_PERSONAL_USERS_FILE || join(process.cwd(), ".telegram-personal-users.json");
export const TELEGRAM_PERSONAL_WATCHLIST_MAX = 5;

/** @typedef {{ type: 'wallet'|'keyword'|'token', value: string }} WatchEntry */

/** @typedef {{
 *   chatId: string,
 *   watchlist: WatchEntry[],
 *   settings: { launchAlerts: boolean, firehose: boolean, claimAlerts: boolean, trending: boolean, hot: boolean },
 *   premium: boolean, // reserved / unused (legacy JSON)
 * }} PersonalUser */

let _chain = Promise.resolve();

function defaultUser(chatId) {
  return {
    chatId: String(chatId),
    watchlist: [],
    settings: {
      launchAlerts: true,
      firehose: false,
      claimAlerts: true,
      trending: true,
      hot: false,
    },
    premium: false,
  };
}

async function loadUsers() {
  try {
    const raw = await readFile(FILE, "utf-8");
    const j = JSON.parse(raw);
    const users = j?.users;
    if (!Array.isArray(users)) return [];
    return users.map((u) => ({
      ...defaultUser(u.chatId),
      ...u,
      chatId: String(u.chatId),
      watchlist: Array.isArray(u.watchlist) ? u.watchlist : [],
      settings: { ...defaultUser(u.chatId).settings, ...(u.settings || {}) },
    }));
  } catch {
    return [];
  }
}

async function saveUsers(users) {
  await mkdir(dirname(FILE), { recursive: true }).catch(() => {});
  await writeFile(FILE, JSON.stringify({ users }, null, 2), "utf-8");
}

function queue(fn) {
  _chain = _chain.then(fn, fn);
  return _chain;
}

export function isPersonalDmsEnabled() {
  const v = process.env.TELEGRAM_PERSONAL_DMS_ENABLED;
  return v === "true" || v === "1";
}

/** If TELEGRAM_DM_ALLOWED_USER_IDS is set, chat must be listed; if unset, all users allowed. */
export function isChatAllowedForPersonalFeatures(chatId) {
  const raw = process.env.TELEGRAM_DM_ALLOWED_USER_IDS;
  if (raw == null || String(raw).trim() === "") return true;
  const ids = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.includes(String(chatId));
}

/**
 * Build watch Sets for watch-match.js (wallet, keywords, tokenAddresses; x/fc unused for personal).
 * @param {PersonalUser} user
 */
export function userToWatchListSets(user) {
  const wallet = new Set();
  const keywords = new Set();
  const tokenAddresses = new Set();
  for (const e of user.watchlist || []) {
    if (!e || !e.value) continue;
    const v = String(e.value).trim().toLowerCase();
    if (e.type === "wallet") wallet.add(v);
    else if (e.type === "keyword") keywords.add(v);
    else if (e.type === "token") tokenAddresses.add(v);
  }
  return {
    x: new Set(),
    fc: new Set(),
    wallet,
    keywords,
    tokenAddresses,
  };
}

/** claim: { poolToken?, poolSymbol? } from doppler watcher */
export function userMatchesClaim(user, claim) {
  if (!user?.settings?.claimAlerts) return false;
  const token = (claim.poolToken || "").trim().toLowerCase();
  const sym = (claim.poolSymbol || "").toLowerCase();
  const hay = `${token} ${sym}`;
  for (const e of user.watchlist || []) {
    if (!e?.value) continue;
    const v = String(e.value).trim().toLowerCase();
    if (e.type === "token" && token && v === token) return true;
    if (e.type === "keyword" && v && (sym.includes(v) || hay.includes(v))) return true;
    if (e.type === "wallet") {
      /* fee claim events usually don't include arbitrary wallet in text; keywords "claim" etc. still work */
    }
  }
  return false;
}

export async function getAllPersonalUsers() {
  return loadUsers();
}

export async function getPersonalUser(chatId) {
  const id = String(chatId);
  const users = await loadUsers();
  return users.find((u) => u.chatId === id) ?? null;
}

export async function registerPersonalUser(chatId) {
  const id = String(chatId);
  return queue(async () => {
    const users = await loadUsers();
    if (users.some((u) => u.chatId === id)) return users.find((u) => u.chatId === id);
    const u = defaultUser(id);
    users.push(u);
    await saveUsers(users);
    return u;
  });
}

export async function addWatchlistEntry(chatId, entry) {
  const id = String(chatId);
  return queue(async () => {
    const users = await loadUsers();
    let u = users.find((x) => x.chatId === id);
    if (!u) {
      u = defaultUser(id);
      users.push(u);
    }
    if (u.watchlist.length >= TELEGRAM_PERSONAL_WATCHLIST_MAX) return { ok: false, error: "LIMIT" };
    const exists = u.watchlist.some((x) => x.type === entry.type && x.value === entry.value);
    if (exists) return { ok: true, user: u, duplicate: true };
    u.watchlist.push(entry);
    await saveUsers(users);
    return { ok: true, user: u };
  });
}

export async function removeWatchlistEntry(chatId, valueRaw) {
  const id = String(chatId);
  const needle = String(valueRaw).trim().toLowerCase();
  return queue(async () => {
    const users = await loadUsers();
    const u = users.find((x) => x.chatId === id);
    if (!u) return { ok: false, error: "NOUSER" };
    const before = u.watchlist.length;
    u.watchlist = u.watchlist.filter((x) => String(x.value).trim().toLowerCase() !== needle);
    await saveUsers(users);
    return { ok: u.watchlist.length < before, user: u };
  });
}

export async function updatePersonalSettings(chatId, partial) {
  const id = String(chatId);
  return queue(async () => {
    const users = await loadUsers();
    let u = users.find((x) => x.chatId === id);
    if (!u) {
      u = defaultUser(id);
      users.push(u);
    }
    u.settings = { ...u.settings, ...partial };
    await saveUsers(users);
    return u;
  });
}

export async function setPersonalPremium(chatId, value) {
  const id = String(chatId);
  return queue(async () => {
    const users = await loadUsers();
    let u = users.find((x) => x.chatId === id);
    if (!u) {
      u = defaultUser(id);
      users.push(u);
    }
    u.premium = !!value;
    await saveUsers(users);
    return u;
  });
}
