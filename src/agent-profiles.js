#!/usr/bin/env node
/**
 * Poll Bankr Agent Profiles API and track seen profiles for "new agent" alerts.
 * API: https://docs.bankr.bot/agent-profiles/rest-api
 * Public: GET https://api.bankr.bot/agent-profiles?sort=newest&limit=50
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_PROFILES_API = "https://api.bankr.bot/agent-profiles";
const SEEN_AGENTS_FILE = process.env.SEEN_AGENTS_FILE || join(process.cwd(), ".bankr-seen-agents.json");
const SEEN_AGENTS_MAX = Math.min(parseInt(process.env.SEEN_AGENTS_MAX || "500", 10), 2000);

/**
 * Fetch approved agent profiles (newest first). No auth required.
 * @param {{ limit?: number, offset?: number, sort?: 'marketCap'|'newest' }} [opts]
 * @returns {Promise<{ profiles: Array<{ id: string, slug: string, projectName: string, tokenSymbol?: string, tokenAddress?: string, marketCapUsd?: number, weeklyRevenueWeth?: string, createdAt?: string }>, total: number }>}
 */
export async function fetchAgentProfiles(opts = {}) {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const sort = opts.sort ?? "newest";
  const url = `${AGENT_PROFILES_API}?sort=${sort}&limit=${limit}&offset=${offset}`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      console.error(`[Agent profiles] API ${res.status} ${res.statusText}: ${url}`);
      return { profiles: [], total: 0 };
    }
    const data = await res.json();
    const profiles = Array.isArray(data.profiles) ? data.profiles : [];
    const total = typeof data.total === "number" ? data.total : profiles.length;
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
  if (profiles.length === 0 && total === 0) {
    console.warn("[Agent profiles] API returned no profiles (check network / api.bankr.bot)");
  }
  const newProfiles = [];
  for (const p of profiles) {
    const id = p.id || p.slug || p.tokenAddress;
    if (!id) continue;
    const key = String(id).trim().toLowerCase();
    if (seen.has(key)) continue;
    newProfiles.push(p);
    seen.add(key);
  }
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
 * Calls onNew(profile) when we receive AGENT_PROFILE_UPDATE for a profile we haven't seen.
 * @param {(profile: object) => void} onNew
 * @returns {() => void} Unsubscribe function
 */
export function subscribeAgentProfileUpdates(onNew) {
  let socket = null;
  async function connect() {
    try {
      const { io } = await import("socket.io-client");
      socket = io(AGENT_PROFILES_WS_URL + "/agent-profiles", { transports: ["websocket"], reconnection: true });
      socket.on("connect", () => console.log("[Agent profiles] WebSocket connected for real-time new-agent pings"));
      socket.on("connect_error", (e) => console.warn("[Agent profiles] WebSocket connect_error:", e.message));
      socket.on("AGENT_PROFILE_UPDATE", async (profile) => {
        const newProfile = await markSeenAndReturnIfNew(profile);
        if (newProfile) onNew(newProfile);
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
