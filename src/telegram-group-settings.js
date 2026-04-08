/**
 * Per–Telegram-group settings: paste lookup, **group watchlist**, hot/trending toggles.
 * Use TELEGRAM_GROUP_SETTINGS_FILE on a volume in production (same pattern as personal users file).
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";

const FILE =
  process.env.TELEGRAM_GROUP_SETTINGS_FILE || join(process.cwd(), ".telegram-group-settings.json");

const DEFAULT_WATCHLIST = { x: [], fc: [], wallet: [], keywords: [] };

/** @typedef {{
 *   tokenLookupInGroup?: boolean,
 *   watchlist?: { x?: unknown[], fc?: unknown[], wallet?: unknown[], keywords?: unknown[] },
 *   alertWatchMatch?: boolean,
 *   alertHot?: boolean,
 *   alertTrending?: boolean,
 *   topicWatch?: number|string|null,
 *   topicHot?: number|string|null,
 *   topicTrending?: number|string|null,
 * }} GroupSettings */

let _chain = Promise.resolve();

function queue(fn) {
  _chain = _chain.then(fn, fn);
  return _chain;
}

function watchEntryValue(entry) {
  if (entry == null) return "";
  if (typeof entry === "string") return entry.trim().toLowerCase();
  if (typeof entry === "object" && entry && typeof entry.value === "string") return entry.value.trim().toLowerCase();
  return "";
}

function defaultSettings() {
  return {
    tokenLookupInGroup: true,
    watchlist: { ...DEFAULT_WATCHLIST },
    alertWatchMatch: true,
    alertHot: false,
    alertTrending: false,
    topicWatch: null,
    topicHot: null,
    topicTrending: null,
  };
}

async function loadAll() {
  try {
    const raw = await readFile(FILE, "utf-8");
    const j = JSON.parse(raw);
    const chats = j?.chats;
    if (!chats || typeof chats !== "object") return {};
    return chats;
  } catch {
    return {};
  }
}

async function saveAll(chats) {
  await mkdir(dirname(FILE), { recursive: true }).catch(() => {});
  await writeFile(FILE, JSON.stringify({ chats }, null, 2), "utf-8");
}

/**
 * @param {string|number} chatId
 * @returns {Promise<GroupSettings>}
 */
export async function getTelegramGroupSettings(chatId) {
  const id = String(chatId);
  const chats = await loadAll();
  const row = chats[id];
  const base = defaultSettings();
  if (!row || typeof row !== "object") return base;
  return {
    ...base,
    ...row,
    watchlist: {
      ...DEFAULT_WATCHLIST,
      ...(row.watchlist && typeof row.watchlist === "object" ? row.watchlist : {}),
    },
  };
}

/**
 * @param {string|number} chatId
 * @param {Partial<GroupSettings>} partial
 */
export async function updateTelegramGroupSettings(chatId, partial) {
  const id = String(chatId);
  return queue(async () => {
    const chats = await loadAll();
    const cur = { ...defaultSettings(), ...(chats[id] || {}) };
    const next = { ...cur, ...partial };
    if (partial.watchlist && typeof partial.watchlist === "object") {
      next.watchlist = {
        ...DEFAULT_WATCHLIST,
        ...cur.watchlist,
        ...partial.watchlist,
      };
    }
    chats[id] = next;
    await saveAll(chats);
    return chats[id];
  });
}

/**
 * @param {string|number} chatId
 * @param {'x'|'fc'|'wallet'|'keywords'} type
 * @param {string} value
 * @param {boolean} add
 * @returns {Promise<boolean>}
 */
export async function updateTelegramGroupWatchlist(chatId, type, value, add) {
  if (!["x", "fc", "wallet", "keywords"].includes(type)) return false;
  const id = String(chatId);
  const val = (typeof value === "string" ? value.trim().toLowerCase() : "") || "";
  if (!val) return false;
  return queue(async () => {
    const chats = await loadAll();
    const cur = { ...defaultSettings(), ...(chats[id] || {}) };
    const w = { ...DEFAULT_WATCHLIST, ...cur.watchlist };
    const list = Array.isArray(w[type]) ? [...w[type]] : [];
    if (add) {
      if (list.some((e) => watchEntryValue(e) === val)) return true;
      list.push(val);
      list.sort((a, b) => watchEntryValue(a).localeCompare(watchEntryValue(b), undefined, { sensitivity: "base" }));
    } else {
      const i = list.findIndex((e) => watchEntryValue(e) === val);
      if (i === -1) return false;
      list.splice(i, 1);
    }
    chats[id] = { ...cur, watchlist: { ...w, [type]: list } };
    await saveAll(chats);
    return true;
  });
}

/**
 * @param {string|number} chatId
 * @returns {Promise<{ wallet: { value: string, name?: string|null }[], keywords: { value: string, name?: string|null }[], x: { value: string, name?: string|null }[], fc: { value: string, name?: string|null }[] }>}
 */
export async function getTelegramGroupWatchListDisplay(chatId) {
  const s = await getTelegramGroupSettings(chatId);
  const w = { ...DEFAULT_WATCHLIST, ...s.watchlist };
  const toDisp = (arr) =>
    (Array.isArray(arr) ? arr : []).map((e) => {
      if (typeof e === "string") return { value: e.trim().toLowerCase(), name: null };
      if (e && typeof e === "object" && typeof e.value === "string")
        return { value: e.value.trim().toLowerCase(), name: e.name && String(e.name).trim() ? String(e.name).trim() : null };
      return null;
    }).filter(Boolean);
  return {
    x: toDisp(w.x),
    fc: toDisp(w.fc),
    wallet: toDisp(w.wallet),
    keywords: toDisp(w.keywords),
  };
}

/**
 * One row per group chat that has ever been configured — used by notify to post watch/hot/trending.
 * @returns {Promise<Array<{
 *   chatId: string,
 *   watchListSets: { x: Set<string>, fc: Set<string>, wallet: Set<string>, keywords: Set<string> },
 *   alertWatchMatch: boolean,
 *   alertHot: boolean,
 *   alertTrending: boolean,
 *   topicWatch: number|string|null,
 *   topicHot: number|string|null,
 *   topicTrending: number|string|null,
 * }>>}
 */
export async function listTelegramGroupAlertConfigs() {
  const chats = await loadAll();
  const out = [];
  for (const [id, row] of Object.entries(chats)) {
    const s = {
      ...defaultSettings(),
      ...(row && typeof row === "object" ? row : {}),
      watchlist: {
        ...DEFAULT_WATCHLIST,
        ...(row?.watchlist && typeof row.watchlist === "object" ? row.watchlist : {}),
      },
    };
    const w = s.watchlist;
    const toSet = (arr) => new Set((Array.isArray(arr) ? arr : []).map(watchEntryValue).filter(Boolean));
    out.push({
      chatId: id,
      watchListSets: {
        x: toSet(w.x),
        fc: toSet(w.fc),
        wallet: toSet(w.wallet),
        keywords: toSet(w.keywords),
      },
      alertWatchMatch: s.alertWatchMatch !== false,
      alertHot: s.alertHot === true,
      alertTrending: s.alertTrending === true,
      topicWatch: s.topicWatch != null && s.topicWatch !== "" ? s.topicWatch : null,
      topicHot: s.topicHot != null && s.topicHot !== "" ? s.topicHot : null,
      topicTrending: s.topicTrending != null && s.topicTrending !== "" ? s.topicTrending : null,
    });
  }
  return out;
}

/** @param {{ x: Set<string>, fc: Set<string>, wallet: Set<string>, keywords: Set<string> }} sets */
export function telegramGroupWatchListHasEntries(sets) {
  return (
    (sets.x?.size ?? 0) +
      (sets.fc?.size ?? 0) +
      (sets.wallet?.size ?? 0) +
      (sets.keywords?.size ?? 0) >
    0
  );
}
