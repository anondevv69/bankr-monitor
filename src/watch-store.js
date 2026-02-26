/**
 * Persistent watch list (X, Farcaster, wallet, keywords) for Bankr launch alerts.
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

/** Only accepts full 0x + 40 hex chars. Truncated display (0x1234…abcd) is never stored. */
function parseWallet(s) {
  if (!s || typeof s !== "string") return null;
  const t = s.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(t)) return t.toLowerCase();
  return null;
}

function parseKeyword(s) {
  if (!s || typeof s !== "string") return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

const DEFAULT_RAW = { x: [], fc: [], wallet: [], keywords: [] };

async function loadRaw() {
  try {
    const data = await readFile(WATCH_FILE, "utf-8");
    const raw = JSON.parse(data);
    return {
      x: Array.isArray(raw.x) ? raw.x : [],
      fc: Array.isArray(raw.fc) ? raw.fc : [],
      wallet: Array.isArray(raw.wallet) ? raw.wallet : [],
      keywords: Array.isArray(raw.keywords) ? raw.keywords : [],
    };
  } catch {
    return { ...DEFAULT_RAW };
  }
}

async function saveRaw(raw) {
  await mkdir(dirname(WATCH_FILE), { recursive: true }).catch(() => {});
  await writeFile(WATCH_FILE, JSON.stringify(raw, null, 2));
}

/** Merge env vars with file */
export function getFromEnv() {
  const x = (process.env.WATCH_X_USERS || "").split(",").map((s) => parseHandle(s)).filter(Boolean);
  const fc = (process.env.WATCH_FC_USERS || "").split(",").map((s) => parseHandle(s, false)).filter(Boolean);
  const wallet = (process.env.WATCH_WALLETS || "").split(",").map((s) => parseWallet(s)).filter(Boolean);
  const keywords = (process.env.WATCH_KEYWORDS || "").split(",").map((s) => parseKeyword(s)).filter(Boolean);
  return { x: new Set(x), fc: new Set(fc), wallet: new Set(wallet), keywords: new Set(keywords) };
}

/** Get combined watch list (env + file). Use this in notify.js */
export async function getWatchList() {
  const env = getFromEnv();
  const file = await loadRaw();
  const x = new Set([...env.x, ...file.x.map((s) => parseHandle(s)).filter(Boolean)]);
  const fc = new Set([...env.fc, ...file.fc.map((s) => parseHandle(s, false)).filter(Boolean)]);
  const wallet = new Set([...env.wallet, ...file.wallet.map((s) => parseWallet(s)).filter(Boolean)]);
  const keywords = new Set([...env.keywords, ...file.keywords.map((s) => parseKeyword(s)).filter(Boolean)]);
  return { x, fc, wallet, keywords };
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

/** Add wallet address to file store */
export async function addWallet(addr) {
  const a = parseWallet(addr);
  if (!a) return false;
  const raw = await loadRaw();
  if (raw.wallet.includes(a)) return true;
  raw.wallet.push(a);
  raw.wallet.sort();
  await saveRaw(raw);
  return true;
}

/** Remove wallet address from file store */
export async function removeWallet(addr) {
  const a = parseWallet(addr);
  if (!a) return false;
  const raw = await loadRaw();
  raw.wallet = raw.wallet.filter((w) => w !== a);
  await saveRaw(raw);
  return true;
}

/** Add keyword to file store */
export async function addKeyword(keyword) {
  const k = parseKeyword(keyword);
  if (!k) return false;
  const raw = await loadRaw();
  const kLower = k.toLowerCase();
  if (raw.keywords.some((w) => w.toLowerCase() === kLower)) return true;
  raw.keywords.push(k);
  raw.keywords.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  await saveRaw(raw);
  return true;
}

/** Remove keyword from file store */
export async function removeKeyword(keyword) {
  const k = parseKeyword(keyword);
  if (!k) return false;
  const raw = await loadRaw();
  const kLower = k.toLowerCase();
  raw.keywords = raw.keywords.filter((w) => w.toLowerCase() !== kLower);
  await saveRaw(raw);
  return true;
}

/** List current watch list from file */
export async function list() {
  const raw = await loadRaw();
  return { x: [...raw.x], fc: [...raw.fc], wallet: [...raw.wallet], keywords: [...raw.keywords] };
}
