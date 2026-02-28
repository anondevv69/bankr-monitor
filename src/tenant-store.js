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
    alertChannelId: t.alertChannelId ?? null,
    watchAlertChannelId: t.watchAlertChannelId ?? null,
    telegramChatId: t.telegramChatId ?? null,
    rules: { ...DEFAULT_RULES, ...t.rules },
    watchlist: { ...DEFAULT_WATCHLIST, ...t.watchlist },
    dopplerIndexerUrl: t.dopplerIndexerUrl ?? null,
    rpcUrl: t.rpcUrl ?? null,
    createdAt: t.createdAt ?? null,
    updatedAt: t.updatedAt ?? null,
  };
}

/**
 * Set (create or update) tenant config for a guild.
 * @param {string} guildId
 * @param {Partial<{ bankrApiKey: string, alertChannelId: string, watchAlertChannelId: string, telegramChatId: string, rules: object, watchlist: object, dopplerIndexerUrl: string, rpcUrl: string }>} updates
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
    return t && (t.alertChannelId || t.watchAlertChannelId || t.telegramChatId);
  });
}

/**
 * Get watchlist for a guild from tenant config (or default).
 */
export async function getWatchListForGuild(guildId) {
  const tenant = await getTenant(guildId);
  const w = tenant?.watchlist ?? DEFAULT_WATCHLIST;
  return {
    x: new Set(Array.isArray(w.x) ? w.x : []),
    fc: new Set(Array.isArray(w.fc) ? w.fc : []),
    wallet: new Set(Array.isArray(w.wallet) ? w.wallet : []),
    keywords: new Set(Array.isArray(w.keywords) ? w.keywords : []),
  };
}

/**
 * Update watchlist for a guild (merge with existing).
 * @param {string} guildId
 * @param {'x'|'fc'|'wallet'|'keywords'} type
 * @param {string} value - handle, wallet address, or keyword
 * @param {boolean} add - true to add, false to remove
 */
export async function updateWatchListForGuild(guildId, type, value, add) {
  const tenant = await getTenant(guildId);
  const w = { ...DEFAULT_WATCHLIST, ...tenant?.watchlist };
  const list = Array.isArray(w[type]) ? [...w[type]] : [];
  const normalized = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");
  const val = normalized(value);
  if (!val) return false;
  if (add) {
    if (list.includes(val)) return true;
    list.push(val);
    list.sort();
  } else {
    const i = list.findIndex((x) => normalized(x) === val);
    if (i === -1) return false;
    list.splice(i, 1);
  }
  await setTenant(guildId, { watchlist: { ...w, [type]: list } });
  return true;
}
