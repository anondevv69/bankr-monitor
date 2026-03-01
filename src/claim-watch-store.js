/**
 * Persist last-known claimable fees per (guild, token) for claim-watch.
 * Used to detect when claimable drops = fees were claimed.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAIM_STATE_FILE = process.env.CLAIM_STATE_FILE || join(process.cwd(), ".bankr-claim-state.json");

function parseTokenAddress(s) {
  if (!s || typeof s !== "string") return null;
  const t = s.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(t)) return null;
  return t.toLowerCase();
}

async function loadAll() {
  try {
    const data = await readFile(CLAIM_STATE_FILE, "utf-8");
    const raw = JSON.parse(data);
    return typeof raw === "object" && raw !== null ? raw : {};
  } catch {
    return {};
  }
}

async function saveAll(state) {
  await mkdir(dirname(CLAIM_STATE_FILE), { recursive: true }).catch(() => {});
  await writeFile(CLAIM_STATE_FILE, JSON.stringify(state, null, 0));
}

/**
 * Get last stored claimable state for a guild/token.
 * @returns {{ lastClaimableToken: number, lastClaimableWeth: number, symbol: string } | null}
 */
export async function getClaimState(guildId, tokenAddress) {
  const addr = parseTokenAddress(tokenAddress);
  if (!addr || !guildId || typeof guildId !== "string") return null;
  const all = await loadAll();
  const guild = all[guildId.trim()];
  if (!guild || typeof guild !== "object") return null;
  return guild[addr] ?? null;
}

/**
 * Set last-known claimable for a guild/token.
 * @param {string} guildId
 * @param {string} tokenAddress
 * @param {{ lastClaimableToken: number, lastClaimableWeth: number, symbol: string }} data
 */
export async function setClaimState(guildId, tokenAddress, data) {
  const addr = parseTokenAddress(tokenAddress);
  if (!addr || !guildId || typeof guildId !== "string") return;
  const all = await loadAll();
  const key = guildId.trim();
  if (!all[key] || typeof all[key] !== "object") all[key] = {};
  all[key][addr] = {
    lastClaimableToken: data.lastClaimableToken,
    lastClaimableWeth: data.lastClaimableWeth,
    symbol: data.symbol ?? "—",
  };
  await saveAll(all);
}
