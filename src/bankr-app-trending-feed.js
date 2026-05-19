/**
 * Recent hot/trending events for the Bankr App feed (same signals as Discord/Telegram pings).
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { randomBytes } from "crypto";

const FILE =
  process.env.BANKR_APP_TRENDING_FEED_FILE ||
  join(process.cwd(), ".bankr-app-trending-feed.json");
const MAX_ENTRIES = Math.min(500, Math.max(20, parseInt(process.env.BANKR_APP_TRENDING_FEED_MAX || "120", 10)));

let _chain = Promise.resolve();
let _memory = [];

function queue(fn) {
  _chain = _chain.then(fn, fn);
  return _chain;
}

function normAddr(addr) {
  const s = String(addr ?? "").trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(s) ? s : null;
}

function feedEntryFromLaunch(launch, hotStats, { isHot, isTrending } = {}) {
  const tokenAddress = normAddr(launch?.tokenAddress);
  if (!tokenAddress) return null;
  const types = [];
  if (isTrending) types.push("trending");
  if (isHot) types.push("hot");
  if (types.length === 0) return null;
  const now = new Date().toISOString();
  return {
    id: `${tokenAddress.slice(2, 10)}-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`,
    types,
    recordedAt: now,
    tokenAddress,
    name: launch?.name ?? launch?.tokenName ?? null,
    symbol: launch?.symbol ?? launch?.tokenSymbol ?? null,
    marketCapFormatted: hotStats?.marketCapFormatted ?? null,
    deployedAtMs: launch?.deployedAtMsFromBankr ?? hotStats?.deployedAtMs ?? null,
    buys5m: hotStats?.buys5m ?? null,
    buys30m: hotStats?.buys30m ?? null,
    buys1h: hotStats?.buys1h ?? null,
    holderCount: hotStats?.holderCount ?? null,
    indexerVol1h: hotStats?.indexerVol1h ?? null,
    indexerVol24h: hotStats?.indexerVol24h ?? null,
    hotByBuys: hotStats?.hotByBuys === true,
    hotByHolders: hotStats?.hotByHolders === true,
    trendingByIndexerVol: hotStats?.trendingByIndexerVol === true,
    bankrUrl: `https://bankr.bot/launches/${tokenAddress}`,
    launcher: launch?.launcher ?? launch?.creatorAddress ?? null,
    launcherX: launch?.launcherX ?? launch?.deployer?.xUsername ?? null,
  };
}

async function loadEntries() {
  if (_memory.length > 0) return [..._memory];
  try {
    const raw = await readFile(FILE, "utf-8");
    const j = JSON.parse(raw);
    const entries = Array.isArray(j?.entries) ? j.entries : [];
    _memory = entries.slice(0, MAX_ENTRIES);
    return [..._memory];
  } catch {
    return [];
  }
}

async function persist(entries) {
  _memory = entries.slice(0, MAX_ENTRIES);
  await mkdir(dirname(FILE), { recursive: true }).catch(() => {});
  await writeFile(FILE, JSON.stringify({ entries: _memory }, null, 2), "utf-8");
}

/**
 * Record a feed item when hot/trending thresholds fire (same moment as alert fanout).
 */
export function recordTrendingFeedEntry(launch, hotStats, { isHot, isTrending } = {}) {
  const entry = feedEntryFromLaunch(launch, hotStats, { isHot, isTrending });
  if (!entry) return;
  void queue(async () => {
    const entries = await loadEntries();
    const recentSame = entries.find(
      (e) =>
        e.tokenAddress === entry.tokenAddress &&
        entry.types.every((t) => (e.types || []).includes(t)) &&
        Date.now() - new Date(e.recordedAt).getTime() < 15 * 60 * 1000
    );
    if (recentSame) return;
    entries.unshift(entry);
    await persist(entries);
  });
}

export async function listTrendingFeed({ limit = 40, type = "all" } = {}) {
  const n = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 40));
  const filter = String(type || "all").toLowerCase();
  const entries = await loadEntries();
  const filtered =
    filter === "trending"
      ? entries.filter((e) => (e.types || []).includes("trending"))
      : filter === "hot"
        ? entries.filter((e) => (e.types || []).includes("hot"))
        : entries;
  return {
    entries: filtered.slice(0, n),
    total: filtered.length,
    maxStored: MAX_ENTRIES,
  };
}
