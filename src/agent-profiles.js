#!/usr/bin/env node
/**
 * Poll Bankr Agent Profiles API and track seen profiles for "new agent" alerts.
 * API: https://docs.bankr.bot/agent-profiles/rest-api
 * Public: GET https://api.bankr.bot/agent-profiles?sort=newest&limit=50
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { bankrApiUserAgent } from "./brand.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_PROFILES_API = process.env.AGENT_PROFILES_API_URL || "https://api.bankr.bot/agent-profiles";
const SEEN_AGENTS_FILE = process.env.SEEN_AGENTS_FILE || join(process.cwd(), ".bankr-seen-agents.json");
const SEEN_AGENTS_MAX = Math.min(parseInt(process.env.SEEN_AGENTS_MAX || "500", 10), 2000);
const AGENT_PROFILES_DEBUG = process.env.AGENT_PROFILES_DEBUG === "1" || process.env.AGENT_PROFILES_DEBUG === "true";

/** Comma-separated slugs to get update alerts for (e.g. WATCHED_AGENT_SLUGS=clanker,truth_terminal). New agents always get one alert. */
function getWatchedAgentSlugs() {
  const raw = process.env.WATCHED_AGENT_SLUGS;
  if (!raw || typeof raw !== "string") return new Set();
  return new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

const FETCH_HEADERS = {
  Accept: "application/json",
  "User-Agent": bankrApiUserAgent("agent-profiles"),
};

/**
 * Fetch approved agent profiles (newest first). No auth required.
 * @param {{ limit?: number, offset?: number, sort?: 'marketCap'|'newest' }} [opts]
 * @returns {Promise<{ profiles: Array<...>, total: number }>}
 */
export async function fetchAgentProfiles(opts = {}) {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const sort = opts.sort ?? "newest";
  const url = `${AGENT_PROFILES_API}?sort=${sort}&limit=${limit}&offset=${offset}`;
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS });
    if (!res.ok) {
      console.error(`[Agent profiles] API ${res.status} ${res.statusText}: ${url}`);
      return { profiles: [], total: 0 };
    }
    const data = await res.json();

    let profiles = [];
    let total = 0;
    if (Array.isArray(data?.profiles)) {
      profiles = data.profiles;
      total = typeof data.total === "number" ? data.total : profiles.length;
    } else if (Array.isArray(data)) {
      profiles = data;
      total = data.length;
    } else if (Array.isArray(data?.data)) {
      profiles = data.data;
      total = typeof data.total === "number" ? data.total : profiles.length;
    } else if (Array.isArray(data?.items)) {
      profiles = data.items;
      total = typeof data.total === "number" ? data.total : profiles.length;
    } else {
      console.warn("[Agent profiles] Unexpected API response shape. Keys:", data && typeof data === "object" ? Object.keys(data).join(", ") : typeof data);
      if (AGENT_PROFILES_DEBUG) console.log("[Agent profiles] Raw response preview:", JSON.stringify(data).slice(0, 300));
    }

    return { profiles, total };
  } catch (e) {
    console.error("[Agent profiles] fetch failed:", e?.message);
    return { profiles: [], total: 0 };
  }
}

/**
 * Load set of seen profile IDs from disk.
 * @returns {Promise<Set<string>>}
 */
export async function getSeenAgentIds() {
  try {
    const data = await readFile(SEEN_AGENTS_FILE, "utf-8");
    const raw = JSON.parse(data);
    const ids = Array.isArray(raw.ids) ? raw.ids : (raw && typeof raw === "object" && Array.isArray(raw) ? raw : []);
    return new Set(ids.filter((id) => id && typeof id === "string"));
  } catch {
    return new Set();
  }
}

/**
 * Persist seen profile IDs. Keeps at most SEEN_AGENTS_MAX entries (oldest dropped).
 * @param {Set<string>} seen
 */
export async function saveSeenAgentIds(seen) {
  const ids = [...seen];
  if (ids.length > SEEN_AGENTS_MAX) {
    ids.splice(0, ids.length - SEEN_AGENTS_MAX);
  }
  await mkdir(dirname(SEEN_AGENTS_FILE), { recursive: true }).catch(() => {});
  await writeFile(SEEN_AGENTS_FILE, JSON.stringify({ ids, updatedAt: new Date().toISOString() }, null, 2));
}

/**
 * Get profiles we haven't seen yet and mark them as seen.
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<...>>}
 */
export async function getNewAgentProfiles(opts = {}) {
  const limit = Math.min(opts.limit ?? 100, 100);
  const [seen, { profiles, total }] = await Promise.all([getSeenAgentIds(), fetchAgentProfiles({ sort: "newest", limit, offset: 0 })]);
  const fetchedCount = profiles.length;
  if (fetchedCount === 0 && total === 0) {
    console.warn("[Agent profiles] API returned no profiles (check network / api.bankr.bot)");
  }
  const newProfiles = [];
  for (const p of profiles) {
    if (p.status !== "approved") continue;
    const id = p.id || p.slug || p.tokenAddress;
    if (!id) continue;
    const key = String(id).trim().toLowerCase();
    if (seen.has(key)) continue;
    newProfiles.push(p);
    seen.add(key);
  }
  console.log(`[Agent profiles] Poll: API returned ${fetchedCount} profile(s), ${newProfiles.length} new (not seen)`);
  if (newProfiles.length > 0) await saveSeenAgentIds(seen);
  return newProfiles;
}

const AGENT_PROFILES_WS_URL = "https://api.bankr.bot";

/**
 * If this profile is not yet seen, mark it seen and return it; otherwise return null.
 * Used for WebSocket AGENT_PROFILE_UPDATE so we only ping once per profile.
 * @param {object} profile - Profile object from API/WebSocket (id, slug, projectName, tokenAddress, etc.)
 * @returns {Promise<object|null>} The profile if new, null if already seen
 */
export async function markSeenAndReturnIfNew(profile) {
  if (!profile || typeof profile !== "object") return null;
  if (profile.status !== "approved") return null;
  const id = profile.id || profile.slug || profile.tokenAddress;
  if (!id) return null;
  const key = String(id).trim().toLowerCase();
  const seen = await getSeenAgentIds();
  if (seen.has(key)) return null;
  seen.add(key);
  await saveSeenAgentIds(seen);
  return profile;
}

/**
 * Subscribe to Bankr agent-profiles WebSocket for real-time new/updated profile events.
 * Calls onNew(profile) when: (1) a new profile we haven't seen, or (2) an update for a WATCHED_AGENT_SLUGS profile.
 * @param {(profile: object) => void} onNew
 * @returns {() => void} Unsubscribe function
 */
export function subscribeAgentProfileUpdates(onNew) {
  const watchedSlugs = getWatchedAgentSlugs();
  let socket = null;
  async function connect() {
    try {
      const { io } = await import("socket.io-client");
      socket = io(AGENT_PROFILES_WS_URL + "/agent-profiles", { transports: ["websocket"], reconnection: true });
      socket.on("connect", () => console.log("[Agent profiles] WebSocket connected for real-time new-agent pings"));
      socket.on("connect_error", (e) => console.warn("[Agent profiles] WebSocket connect_error:", e.message));
      socket.on("AGENT_PROFILE_UPDATE", async (profile) => {
        const slug = (profile?.slug || profile?.id || "").toString().trim().toLowerCase();
        const isWatched = slug && watchedSlugs.has(slug);
        const newProfile = await markSeenAndReturnIfNew(profile);
        if (newProfile) onNew(newProfile);
        else if (isWatched && profile?.status === "approved") onNew(profile);
      });
    } catch (e) {
      console.warn("[Agent profiles] WebSocket unavailable:", e?.message);
    }
  }
  connect();
  return () => {
    if (socket) socket.removeAllListeners(), socket.disconnect();
  };
}
