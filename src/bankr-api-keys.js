/**
 * Multiple Bankr API keys for reads/lookups: round-robin spreads quota and reduces 429 delays.
 *
 * Configure either:
 *   BANKR_API_KEYS=key1,key2,key3   (comma or newline separated)
 * or
 *   BANKR_API_KEY=key1,key2,key3    (same — backward compatible with a single key)
 *
 * Tenant / explicit options.bankrApiKey still wins over env pool.
 * Deploy (/deploy) uses getPrimaryBankrApiKey() — first key in the list when no tenant key.
 */

let _rr = 0;
let _cachedList = null;

function parseKeyList() {
  const multi = process.env.BANKR_API_KEYS?.trim();
  if (multi) {
    return multi
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const single = process.env.BANKR_API_KEY?.trim();
  if (!single) return [];
  if (single.includes(",") || single.includes("\n")) {
    return single
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [single];
}

/** @returns {string[]} */
export function listEnvBankrApiKeys() {
  if (_cachedList === null) _cachedList = parseKeyList();
  return _cachedList;
}

/** For tests or reload after env mutation */
export function refreshBankrApiKeysFromEnv() {
  _cachedList = null;
}

export function hasEnvBankrApiKeys() {
  return listEnvBankrApiKeys().length > 0;
}

/** First key — use for deploy and other operations that should not rotate mid-request. */
export function getPrimaryBankrApiKey() {
  const keys = listEnvBankrApiKeys();
  return keys[0] ?? null;
}

/** Next key from env pool (round-robin). */
export function pickBankrApiKeyRoundRobin() {
  const keys = listEnvBankrApiKeys();
  if (keys.length === 0) return null;
  const i = _rr++ % keys.length;
  return keys[i];
}

/**
 * Use explicit tenant/user key if set; otherwise pick from env pool.
 * @param {string|null|undefined} override
 * @returns {string|null}
 */
export function resolveBankrApiKey(override) {
  const o = override && String(override).trim();
  if (o) return o;
  return pickBankrApiKeyRoundRobin();
}
