/**
 * Per-user Telegram DM preferences: watchlist (max 5), alert toggles.
 * JSON file — use a Railway volume path for persistence.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { isBankrTokenAddress } from "./bankr-token.js";

const FILE = process.env.TELEGRAM_PERSONAL_USERS_FILE || join(process.cwd(), ".telegram-personal-users.json");
export const TELEGRAM_PERSONAL_WATCHLIST_MAX = 5;

/**
 * @typedef {{
 *   mcapUsdMin?: number|null,
 *   minBuys15m?: number|null,
 *   minSells15m?: number|null,
 *   minSwaps15m?: number|null,
 *   minBuys1h?: number|null,
 *   minSells1h?: number|null,
 *   minBuys24h?: number|null,
 *   minSells24h?: number|null,
 *   minTrades24h?: number|null,
 *   cooldownSec: number,
 *   lastAlertAtMs?: number|null,
 * }} PersonalActivityRule */

/** @typedef {{ type: 'wallet'|'keyword'|'token'|'activity', value: string, activity?: PersonalActivityRule }} WatchEntry */

/** @typedef {{
 *   chatId: string,
 *   watchlist: WatchEntry[],
 *   settings: { launchAlerts: boolean, firehose: boolean (ignored; DMs never firehose), claimAlerts: boolean, trending: boolean, hot: boolean },
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
    // type "activity" — threshold DMs only; does not match launches/claims as token
  }
  return {
    x: new Set(),
    fc: new Set(),
    wallet,
    keywords,
    tokenAddresses,
  };
}

/**
 * Why this claim matched the user's watchlist (token CA or keyword on symbol/text).
 * @param {{ watchlist?: WatchEntry[] } | null} user
 * @param {{ poolToken?: string, poolSymbol?: string }} claim
 * @returns {string[]}
 */
export function getClaimMatchReasons(user, claim) {
  if (!(user.watchlist?.length > 0)) return [];
  const reasons = [];
  const token = (claim.poolToken || "").trim().toLowerCase();
  const sym = (claim.poolSymbol || "").toLowerCase();
  const hay = `${token} ${sym}`;
  for (const e of user.watchlist || []) {
    if (!e?.value) continue;
    const v = String(e.value).trim().toLowerCase();
    const orig = String(e.value).trim();
    if (e.type === "token" && token && v === token) {
      reasons.push(`Token CA \`${token.slice(0, 6)}…${token.slice(-4)}\` is on your watch list`);
    } else if (e.type === "keyword" && v && (sym.includes(v) || hay.includes(v))) {
      reasons.push(`Keyword “${orig}” matched this claim (symbol or token)`);
    }
  }
  return [...new Set(reasons)];
}

/** claim: { poolToken?, poolSymbol? } from doppler watcher */
export function userMatchesClaim(user, claim) {
  if (!user?.settings?.claimAlerts) return false;
  if (!(user.watchlist?.length > 0)) return false;
  return getClaimMatchReasons(user, claim).length > 0;
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
    // Do not remove type "activity" here — use /activity remove <0x> so token+activity can coexist
    u.watchlist = u.watchlist.filter((x) => {
      if (String(x.value).trim().toLowerCase() !== needle) return true;
      return x.type === "activity";
    });
    await saveUsers(users);
    return { ok: u.watchlist.length < before, user: u };
  });
}

function normAddr40(s) {
  if (!s || typeof s !== "string") return null;
  const t = s.trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(t) ? t : null;
}

function personalActivityHasAnyThreshold(a) {
  return !!(
    (a.mcapUsdMin != null && a.mcapUsdMin > 0) ||
    (a.minBuys15m != null && a.minBuys15m > 0) ||
    (a.minSells15m != null && a.minSells15m > 0) ||
    (a.minSwaps15m != null && a.minSwaps15m > 0) ||
    (a.minBuys1h != null && a.minBuys1h > 0) ||
    (a.minSells1h != null && a.minSells1h > 0) ||
    (a.minBuys24h != null && a.minBuys24h > 0) ||
    (a.minSells24h != null && a.minSells24h > 0) ||
    (a.minTrades24h != null && a.minTrades24h > 0)
  );
}

/**
 * Add one activity-threshold row (counts toward TELEGRAM_PERSONAL_WATCHLIST_MAX). One per token per user.
 * @param {string} chatId
 * @param {string} tokenAddress
 * @param {Omit<PersonalActivityRule, 'lastAlertAtMs'> & { lastAlertAtMs?: number|null }} rule
 */
export async function addPersonalActivityWatch(chatId, tokenAddress, rule) {
  const id = String(chatId);
  const addr = normAddr40(tokenAddress);
  if (!addr || !isBankrTokenAddress(addr)) return { ok: false, error: "BAD_TOKEN" };
  const activity = {
    mcapUsdMin: rule.mcapUsdMin ?? null,
    minBuys15m: rule.minBuys15m ?? null,
    minSells15m: rule.minSells15m ?? null,
    minSwaps15m: rule.minSwaps15m ?? null,
    minBuys1h: rule.minBuys1h ?? null,
    minSells1h: rule.minSells1h ?? null,
    minBuys24h: rule.minBuys24h ?? null,
    minSells24h: rule.minSells24h ?? null,
    minTrades24h: rule.minTrades24h ?? null,
    cooldownSec: Math.min(86400, Math.max(60, Math.trunc(Number(rule.cooldownSec) || 900))),
    lastAlertAtMs: rule.lastAlertAtMs ?? null,
  };
  if (!personalActivityHasAnyThreshold(activity)) return { ok: false, error: "NO_THRESHOLDS" };

  return queue(async () => {
    const users = await loadUsers();
    let u = users.find((x) => x.chatId === id);
    if (!u) {
      u = defaultUser(id);
      users.push(u);
    }
    if (u.watchlist.some((x) => x.type === "activity" && x.value === addr)) {
      return { ok: false, error: "DUPLICATE_ACTIVITY" };
    }
    if (u.watchlist.length >= TELEGRAM_PERSONAL_WATCHLIST_MAX) return { ok: false, error: "LIMIT" };
    u.watchlist.push({ type: "activity", value: addr, activity });
    await saveUsers(users);
    return { ok: true, user: u };
  });
}

/** Remove only the activity row for this token (not wallet/token/keyword rows). */
export async function removePersonalActivityWatch(chatId, tokenAddress) {
  const id = String(chatId);
  const addr = normAddr40(tokenAddress);
  if (!addr) return { ok: false, error: "BAD_TOKEN" };
  return queue(async () => {
    const users = await loadUsers();
    const u = users.find((x) => x.chatId === id);
    if (!u) return { ok: false, error: "NOUSER" };
    const before = u.watchlist.length;
    u.watchlist = u.watchlist.filter((x) => !(x.type === "activity" && x.value === addr));
    await saveUsers(users);
    return { ok: u.watchlist.length < before, user: u };
  });
}

export async function touchPersonalActivityAlert(chatId, tokenAddress, lastAlertAtMs) {
  const id = String(chatId);
  const addr = normAddr40(tokenAddress);
  if (!addr) return false;
  return queue(async () => {
    const users = await loadUsers();
    const u = users.find((x) => x.chatId === id);
    if (!u) return false;
    let found = false;
    u.watchlist = u.watchlist.map((e) => {
      if (e.type === "activity" && e.value === addr && e.activity) {
        found = true;
        return { ...e, activity: { ...e.activity, lastAlertAtMs } };
      }
      return e;
    });
    if (found) await saveUsers(users);
    return found;
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
