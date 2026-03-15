/**
 * Per-guild (tenant) config for multi-tenant Bankr monitor.
 * Each Discord server has its own: API key, alert channels, rules, watchlist.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TENANTS_FILE = process.env.TENANTS_FILE || join(process.cwd(), ".bankr-tenants.json");

const DEFAULT_RULES = {
  filterXMatch: false,
  filterFeeRecipientHasX: false,
  filterMaxDeploys: null,
  pollIntervalMs: 60_000,
};

const DEFAULT_WATCHLIST = { x: [], fc: [], wallet: [], keywords: [] };

async function loadAll() {
  try {
    const data = await readFile(TENANTS_FILE, "utf-8");
    const raw = JSON.parse(data);
    return typeof raw === "object" && raw !== null ? raw : {};
  } catch {
    return {};
  }
}

async function saveAll(tenants) {
  await mkdir(dirname(TENANTS_FILE), { recursive: true }).catch(() => {});
  await writeFile(TENANTS_FILE, JSON.stringify(tenants, null, 2));
}

/**
 * Get tenant config for a Discord guild. Returns null if not configured.
 * @param {string} guildId - Discord guild (server) ID
 */
export async function getTenant(guildId) {
  if (!guildId || typeof guildId !== "string") return null;
  const tenants = await loadAll();
  const t = tenants[guildId.trim()];
  if (!t) return null;
  return {
    guildId: t.guildId ?? guildId,
    bankrApiKey: t.bankrApiKey ?? null,
    /** Every Bankr launch (no rules). Optional firehose channel. */
    allLaunchesChannelId: t.allLaunchesChannelId ?? null,
    /** Launches that pass filter_x_match / filter_max_deploys (curated). */
    alertChannelId: t.alertChannelId ?? null,
    watchAlertChannelId: t.watchAlertChannelId ?? null,
    hotAlertChannelId: t.hotAlertChannelId ?? null,
    hotLaunchEnabled: t.hotLaunchEnabled !== false,
    /** Discord role IDs to ping (no @everyone). Server assigns who gets tagged. */
    hotLaunchRoleIds: Array.isArray(t.hotLaunchRoleIds) ? t.hotLaunchRoleIds : [],
    /** When true, ping roles when posting to hot channel. Default true. */
    pingOnHot: t.pingOnHot !== false,
    /** When true, ping roles when posting to trending channel. Default true. */
    pingOnTrending: t.pingOnTrending !== false,
    /** When true, ping roles when a launch matches watch list (X/FC/wallet/keyword). Default false. */
    pingOnWatchMatch: t.pingOnWatchMatch === true,
    /** When true, ping roles when posting to curated (alert) channel. Default false. */
    pingOnCurated: t.pingOnCurated === true,
    trendingAlertChannelId: t.trendingAlertChannelId ?? null,
    trendingEnabled: t.trendingEnabled === true,
    telegramChatId: t.telegramChatId ?? null,
    /** Telegram group topic IDs (forum threads). Optional; if set, messages go to that topic. */
    telegramTopicFirehose: t.telegramTopicFirehose != null ? t.telegramTopicFirehose : null,
    telegramTopicCurated: t.telegramTopicCurated != null ? t.telegramTopicCurated : null,
    telegramTopicHot: t.telegramTopicHot != null ? t.telegramTopicHot : null,
    telegramTopicTrending: t.telegramTopicTrending != null ? t.telegramTopicTrending : null,
    /** Delay (ms) before sending hot/trending pings to Telegram after Discord. Null = use env TELEGRAM_HOT_PING_DELAY_MS. */
    telegramHotPingDelayMs: t.telegramHotPingDelayMs != null ? t.telegramHotPingDelayMs : null,
    rules: { ...DEFAULT_RULES, ...t.rules },
    watchlist: { ...DEFAULT_WATCHLIST, ...t.watchlist },
    claimWatchTokens: Array.isArray(t.claimWatchTokens) ? t.claimWatchTokens : [],
    /** Optional labels for claim-watch tokens: { [address]: label } */
    claimWatchLabels: typeof t.claimWatchLabels === "object" && t.claimWatchLabels !== null ? t.claimWatchLabels : {},
    /** Optional channel for fee-claim alerts only; falls back to watch then alert channel. */
    claimAlertChannelId: t.claimAlertChannelId ?? null,
    dopplerIndexerUrl: t.dopplerIndexerUrl ?? null,
    rpcUrl: t.rpcUrl ?? null,
    createdAt: t.createdAt ?? null,
    updatedAt: t.updatedAt ?? null,
  };
}

/**
 * Set (create or update) tenant config for a guild.
 * @param {string} guildId
 * @param {Partial<{ bankrApiKey: string, allLaunchesChannelId: string|null, alertChannelId: string, watchAlertChannelId: string, hotAlertChannelId: string, hotLaunchEnabled: boolean, hotLaunchRoleIds: string[], pingOnHot: boolean, pingOnTrending: boolean, pingOnWatchMatch: boolean, pingOnCurated: boolean, trendingAlertChannelId: string, trendingEnabled: boolean, telegramChatId: string, telegramTopicFirehose: number|string|null, telegramTopicCurated: number|string|null, telegramTopicHot: number|string|null, telegramTopicTrending: number|string|null, telegramHotPingDelayMs: number|null, rules: object, watchlist: object, claimWatchTokens: string[], dopplerIndexerUrl: string, rpcUrl: string }>} updates
 */
export async function setTenant(guildId, updates) {
  if (!guildId || typeof guildId !== "string") return null;
  const tenants = await loadAll();
  const key = guildId.trim();
  const existing = tenants[key] || {};
  const now = new Date().toISOString();
  const next = {
    ...existing,
    guildId: key,
    ...updates,
    createdAt: existing.createdAt ?? now,
    updatedAt: now,
  };
  if (updates.rules && typeof updates.rules === "object") {
    next.rules = { ...DEFAULT_RULES, ...existing.rules, ...updates.rules };
  }
  if (updates.watchlist && typeof updates.watchlist === "object") {
    next.watchlist = { ...DEFAULT_WATCHLIST, ...existing.watchlist, ...updates.watchlist };
  }
  if (Array.isArray(updates.claimWatchTokens)) {
    next.claimWatchTokens = updates.claimWatchTokens;
  }
  if (updates.claimWatchLabels !== undefined && typeof updates.claimWatchLabels === "object" && updates.claimWatchLabels !== null) {
    next.claimWatchLabels = updates.claimWatchLabels;
  }
  if (updates.claimAlertChannelId !== undefined) {
    next.claimAlertChannelId = updates.claimAlertChannelId ?? null;
  }
  if (Array.isArray(updates.hotLaunchRoleIds)) {
    next.hotLaunchRoleIds = updates.hotLaunchRoleIds;
  }
  if (typeof updates.pingOnHot === "boolean") next.pingOnHot = updates.pingOnHot;
  if (typeof updates.pingOnTrending === "boolean") next.pingOnTrending = updates.pingOnTrending;
  if (typeof updates.pingOnWatchMatch === "boolean") next.pingOnWatchMatch = updates.pingOnWatchMatch;
  if (typeof updates.pingOnCurated === "boolean") next.pingOnCurated = updates.pingOnCurated;
  if (updates.telegramTopicFirehose !== undefined) next.telegramTopicFirehose = updates.telegramTopicFirehose;
  if (updates.telegramTopicCurated !== undefined) next.telegramTopicCurated = updates.telegramTopicCurated;
  if (updates.telegramTopicHot !== undefined) next.telegramTopicHot = updates.telegramTopicHot;
  if (updates.telegramTopicTrending !== undefined) next.telegramTopicTrending = updates.telegramTopicTrending;
  if (updates.telegramHotPingDelayMs !== undefined) next.telegramHotPingDelayMs = updates.telegramHotPingDelayMs;
  tenants[key] = next;
  await saveAll(tenants);
  return getTenant(guildId);
}

/**
 * List all tenant guild IDs that have at least one alert channel (for notify loop).
 */
export async function listActiveTenantGuildIds() {
  const tenants = await loadAll();
  return Object.keys(tenants).filter((id) => {
    const t = tenants[id];
    return t && (t.allLaunchesChannelId || t.alertChannelId || t.watchAlertChannelId || t.telegramChatId || t.hotAlertChannelId || t.trendingAlertChannelId);
  });
}

/** Stats for debug webhook: configured servers and Telegram chats. */
export async function getTenantStats() {
  const tenants = await loadAll();
  let guildsWithTelegram = 0;
  for (const t of Object.values(tenants)) {
    if (t && t.telegramChatId) guildsWithTelegram++;
  }
  return {
    configuredGuilds: Object.keys(tenants).length,
    guildsWithTelegram,
  };
}

/** Normalize watch entry to value string (for matching). Entry can be string or { value, name? }. */
function watchEntryValue(entry) {
  if (entry == null) return "";
  if (typeof entry === "string") return entry.trim().toLowerCase();
  if (typeof entry === "object" && entry && typeof entry.value === "string") return entry.value.trim().toLowerCase();
  return "";
}

/** Normalize watch list array to array of { value, name? } for display. */
function watchListToDisplay(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((e) => {
    if (typeof e === "string") return { value: e.trim().toLowerCase(), name: null };
    if (e && typeof e === "object" && typeof e.value === "string")
      return { value: e.value.trim().toLowerCase(), name: e.name && String(e.name).trim() ? String(e.name).trim() : null };
    return null;
  }).filter(Boolean);
}

/**
 * Get watchlist for a guild from tenant config (or default). Returns Sets of values for matching.
 */
export async function getWatchListForGuild(guildId) {
  const tenant = await getTenant(guildId);
  const w = tenant?.watchlist ?? DEFAULT_WATCHLIST;
  const toSet = (arr) => new Set((Array.isArray(arr) ? arr : []).map(watchEntryValue).filter(Boolean));
  return {
    x: toSet(w.x),
    fc: toSet(w.fc),
    wallet: toSet(w.wallet),
    keywords: toSet(w.keywords),
  };
}

/**
 * Get watchlist with optional display names for listing. Returns arrays of { value, name? }.
 */
export async function getWatchListDisplayForGuild(guildId) {
  const tenant = await getTenant(guildId);
  const w = { ...DEFAULT_WATCHLIST, ...tenant?.watchlist };
  return {
    x: watchListToDisplay(w.x),
    fc: watchListToDisplay(w.fc),
    wallet: watchListToDisplay(w.wallet),
    keywords: watchListToDisplay(w.keywords),
  };
}

/**
 * Update watchlist for a guild (merge with existing).
 * @param {string} guildId
 * @param {'x'|'fc'|'wallet'|'keywords'} type
 * @param {string} value - handle, wallet address, or keyword
 * @param {boolean} add - true to add, false to remove
 * @param {string} [name] - optional display name/nickname for this entry
 */
export async function updateWatchListForGuild(guildId, type, value, add, name) {
  const tenant = await getTenant(guildId);
  const w = { ...DEFAULT_WATCHLIST, ...tenant?.watchlist };
  const list = Array.isArray(w[type]) ? [...w[type]] : [];
  const normalized = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");
  const val = normalized(value);
  if (!val) return false;
  if (add) {
    const exists = list.some((e) => watchEntryValue(e) === val);
    if (exists) return true;
    const displayName = name && String(name).trim() ? String(name).trim() : null;
    list.push(displayName ? { value: val, name: displayName } : val);
    list.sort((a, b) => watchEntryValue(a).localeCompare(watchEntryValue(b), undefined, { sensitivity: "base" }));
  } else {
    const i = list.findIndex((e) => watchEntryValue(e) === val);
    if (i === -1) return false;
    list.splice(i, 1);
  }
  await setTenant(guildId, { watchlist: { ...w, [type]: list } });
  return true;
}

/**
 * Update the display name/nickname of an existing watchlist entry. Entry is matched by value.
 * @param {string} guildId
 * @param {'x'|'fc'|'wallet'|'keywords'} type
 * @param {string} value - handle, wallet address, or keyword (must match existing entry)
 * @param {string} [newName] - new nickname; empty string or null to clear the name
 * @returns {Promise<boolean>} true if entry was found and updated
 */
export async function updateWatchListEntryName(guildId, type, value, newName) {
  const tenant = await getTenant(guildId);
  const w = { ...DEFAULT_WATCHLIST, ...tenant?.watchlist };
  const list = Array.isArray(w[type]) ? [...w[type]] : [];
  const val = (typeof value === "string" ? value.trim().toLowerCase() : "") || "";
  if (!val) return false;
  const i = list.findIndex((e) => watchEntryValue(e) === val);
  if (i === -1) return false;
  const displayName = newName != null && String(newName).trim() ? String(newName).trim() : null;
  const entry = list[i];
  list[i] = typeof entry === "string" ? (displayName ? { value: val, name: displayName } : val) : { value: val, name: displayName };
  await setTenant(guildId, { watchlist: { ...w, [type]: list } });
  return true;
}

function parseTokenAddress(s) {
  if (!s || typeof s !== "string") return null;
  const t = s.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(t)) return null;
  return t.toLowerCase();
}

/** Get claim-watch token list for a guild. */
export async function getClaimWatchTokens(guildId) {
  const tenant = await getTenant(guildId);
  const list = tenant?.claimWatchTokens;
  return Array.isArray(list) ? list.filter((a) => parseTokenAddress(a)) : [];
}

/** Add a token address to this server's claim watch list. Returns true if added, false if invalid or already present. Optional label shown in list. */
export async function addClaimWatchToken(guildId, tokenAddress, label) {
  const addr = parseTokenAddress(tokenAddress);
  if (!addr || !guildId || typeof guildId !== "string") return false;
  const tenant = await getTenant(guildId);
  const list = Array.isArray(tenant?.claimWatchTokens) ? [...tenant.claimWatchTokens] : [];
  if (list.includes(addr)) {
    if (label != null && String(label).trim() !== "") {
      const labels = { ...(tenant?.claimWatchLabels || {}) };
      labels[addr] = String(label).trim();
      await setTenant(guildId, { claimWatchLabels: labels });
    }
    return true;
  }
  list.push(addr);
  list.sort();
  const updates = { claimWatchTokens: list };
  if (label != null && String(label).trim() !== "") {
    updates.claimWatchLabels = { ...(tenant?.claimWatchLabels || {}), [addr]: String(label).trim() };
  }
  await setTenant(guildId, updates);
  return true;
}

/** Remove a token from the claim watch list by address or by label. Returns true if removed. */
export async function removeClaimWatchToken(guildId, tokenAddressOrLabel) {
  if (!guildId || typeof guildId !== "string") return false;
  const tenant = await getTenant(guildId);
  const list = Array.isArray(tenant?.claimWatchTokens) ? [...tenant.claimWatchTokens] : [];
  const labels = tenant?.claimWatchLabels || {};
  let addr = parseTokenAddress(tokenAddressOrLabel);
  if (!addr) {
    const search = String(tokenAddressOrLabel || "").trim().toLowerCase();
    const byLabel = list.find((a) => (labels[a] || "").toLowerCase() === search);
    if (byLabel) addr = byLabel;
  }
  if (!addr) return false;
  const next = list.filter((a) => a !== addr);
  if (next.length === list.length) return false;
  const nextLabels = { ...labels };
  delete nextLabels[addr];
  await setTenant(guildId, { claimWatchTokens: next, claimWatchLabels: nextLabels });
  return true;
}
