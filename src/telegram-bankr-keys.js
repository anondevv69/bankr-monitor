/**
 * Bankr API keys used only for Telegram (DM + group token/wallet lookups).
 *
 * Railway: set TELEGRAM_BANKR_API_KEYS=key1,key2,key3 (comma or newline).
 * If set, those keys are tried first (round-robin); BANKR_API_KEY is always appended as a fallback (deduped).
 * If TELEGRAM_* is unset, only BANKR_API_KEY is used. Discord/notify always use BANKR_API_KEY (or /setup) only.
 */

let _rr = 0;

function parseTelegramKeys() {
  const seen = new Set();
  const out = [];
  const push = (s) => {
    const t = s && String(s).trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  const tg = process.env.TELEGRAM_BANKR_API_KEYS?.trim();
  if (tg) {
    for (const part of tg.split(/[\n,]+/)) push(part);
  }
  // Always include main key last so Telegram lookups match Discord when TELEGRAM_* keys are read-only or weaker.
  push(process.env.BANKR_API_KEY);
  return out;
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
