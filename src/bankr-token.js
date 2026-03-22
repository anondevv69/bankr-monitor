/**
 * Bankr deploys token contracts whose address ends with a fixed suffix (Base mainnet: "ba3").
 * Doppler indexers may also list non-Bankr tokens — filter with {@link isBankrTokenAddress}.
 */

export function getBankrTokenSuffix() {
  return (process.env.BANKR_TOKEN_SUFFIX || "ba3").toLowerCase();
}

/**
 * @param {string | null | undefined} addr
 * @returns {boolean}
 */
export function isBankrTokenAddress(addr) {
  if (!addr || typeof addr !== "string") return false;
  const a = addr.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(a)) return false;
  return a.endsWith(getBankrTokenSuffix());
}
