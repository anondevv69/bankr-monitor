/**
 * Display name and HTTP identity for this deployment (personal / self-hosted fork).
 * Set BRAND_DISPLAY_NAME and optionally BRAND_REPO_URL in the environment.
 */

export const BRAND_DISPLAY_NAME = (process.env.BRAND_DISPLAY_NAME || "BankrMonitor Personal").trim();

/** Optional GitHub repo URL for User-Agent (e.g. https://github.com/you/bankr-monitor-personal). */
export const BRAND_REPO_URL = (process.env.BRAND_REPO_URL || "").trim();

/** Compact token for User-Agent (ASCII, no spaces). */
export function brandSlug() {
  return BRAND_DISPLAY_NAME.replace(/\s+/g, "");
}

/**
 * User-Agent string for Bankr HTTP APIs (identifies your fork, not Bankr, Inc.).
 * @param {string} [hint] short context e.g. "lookup", "agent-profiles"
 */
export function bankrApiUserAgent(hint = "fetch") {
  const slug = brandSlug();
  const tail = BRAND_REPO_URL ? ` ${BRAND_REPO_URL}` : "";
  return `${slug}/1.0 (${hint};${tail})`.replace(/\s+/g, " ").trim();
}
