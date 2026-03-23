/**
 * Single Bankr API key from env (Discord, notify, CLI, etc.).
 * Telegram uses telegram-bankr-keys.js for optional multi-key pool.
 */

export function defaultBankrApiKey(override) {
  const o = override != null && String(override).trim();
  if (o) return o;
  return process.env.BANKR_API_KEY?.trim() || null;
}
