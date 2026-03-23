/**
 * Bankr API keys used only for Telegram (DM + group token/wallet lookups).
 *
 * Railway: set TELEGRAM_BANKR_API_KEYS=key1,key2,key3 (comma or newline).
 * If unset, falls back to BANKR_API_KEY (single). Discord/notify always use BANKR_API_KEY only.
 */

let _rr = 0;

function parseTelegramKeys() {
  const tg = process.env.TELEGRAM_BANKR_API_KEYS?.trim();
  if (tg) {
    return tg
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const single = process.env.BANKR_API_KEY?.trim();
  return single ? [single] : [];
}

/** @returns {string[]} */
export function listTelegramBankrApiKeys() {
  return parseTelegramKeys();
}

export function hasTelegramBankrApiKeys() {
  return listTelegramBankrApiKeys().length > 0;
}

/** Round-robin across TELEGRAM_BANKR_API_KEYS (or single BANKR_API_KEY). */
export function pickTelegramBankrApiKeyRoundRobin() {
  const keys = listTelegramBankrApiKeys();
  if (keys.length === 0) return null;
  if (keys.length === 1) return keys[0];
  return keys[_rr++ % keys.length];
}
