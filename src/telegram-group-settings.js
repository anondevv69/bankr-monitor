/**
 * Per–Telegram-group settings (e.g. auto token lookup on pasted Bankr CAs).
 * Use TELEGRAM_GROUP_SETTINGS_FILE on a volume in production (same pattern as personal users file).
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";

const FILE =
  process.env.TELEGRAM_GROUP_SETTINGS_FILE || join(process.cwd(), ".telegram-group-settings.json");

/** @typedef {{ tokenLookupInGroup?: boolean }} GroupSettings */

let _chain = Promise.resolve();

function queue(fn) {
  _chain = _chain.then(fn, fn);
  return _chain;
}

function defaultSettings() {
  return { tokenLookupInGroup: true };
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
  return { ...defaultSettings(), ...(row && typeof row === "object" ? row : {}) };
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
    chats[id] = { ...cur, ...partial };
    await saveAll(chats);
    return chats[id];
  });
}
