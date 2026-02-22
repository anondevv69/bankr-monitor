/**
 * Persistent watch list (X and Farcaster users) for Bankr launch alerts.
 * Used by notify.js and discord-bot.js.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WATCH_FILE = process.env.WATCH_FILE || join(process.cwd(), ".bankr-watch.json");

function parseHandle(s, stripAt = true) {
  if (!s || typeof s !== "string") return null;
  const t = s.trim().toLowerCase();
  return stripAt && t.startsWith("@") ? t.slice(1) : t;
}

async function loadRaw() {
  try {
    const data = await readFile(WATCH_FILE, "utf-8");
    const raw = JSON.parse(data);
    return {
      x: Array.isArray(raw.x) ? raw.x : [],
      fc: Array.isArray(raw.fc) ? raw.fc : [],
    };
  } catch {
    return { x: [], fc: [] };
  }
}

async function saveRaw(raw) {
  await mkdir(dirname(WATCH_FILE), { recursive: true }).catch(() => {});
  await writeFile(WATCH_FILE, JSON.stringify(raw, null, 2));
}

/** Merge env vars with file. Returns { x: Set, fc: Set } */
export function getFromEnv() {
  const x = (process.env.WATCH_X_USERS || "")
    .split(",")
    .map((s) => parseHandle(s))
    .filter(Boolean);
  const fc = (process.env.WATCH_FC_USERS || "")
    .split(",")
    .map((s) => parseHandle(s, false))
    .filter(Boolean);
  return { x: new Set(x), fc: new Set(fc) };
}

/** Get combined watch list (env + file). Use this in notify.js */
export async function getWatchList() {
  const env = getFromEnv();
  const file = await loadRaw();
  const x = new Set([...env.x, ...file.x.map((s) => parseHandle(s)).filter(Boolean)]);
  const fc = new Set([...env.fc, ...file.fc.map((s) => parseHandle(s, false)).filter(Boolean)]);
  return { x, fc };
}

/** Add X handle to file store */
export async function addX(handle) {
  const h = parseHandle(handle);
  if (!h) return false;
  const raw = await loadRaw();
  if (raw.x.includes(h)) return true;
  raw.x.push(h);
  raw.x.sort();
  await saveRaw(raw);
  return true;
}

/** Remove X handle from file store */
export async function removeX(handle) {
  const h = parseHandle(handle);
  if (!h) return false;
  const raw = await loadRaw();
  raw.x = raw.x.filter((x) => x !== h);
  await saveRaw(raw);
  return true;
}

/** Add Farcaster handle to file store */
export async function addFc(handle) {
  const h = parseHandle(handle, false);
  if (!h) return false;
  const raw = await loadRaw();
  if (raw.fc.includes(h)) return true;
  raw.fc.push(h);
  raw.fc.sort();
  await saveRaw(raw);
  return true;
}

/** Remove Farcaster handle from file store */
export async function removeFc(handle) {
  const h = parseHandle(handle, false);
  if (!h) return false;
  const raw = await loadRaw();
  raw.fc = raw.fc.filter((x) => x !== h);
  await saveRaw(raw);
  return true;
}

/** List current watch list from file */
export async function list() {
  const raw = await loadRaw();
  return { x: [...raw.x], fc: [...raw.fc] };
}
