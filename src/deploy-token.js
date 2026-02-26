#!/usr/bin/env node
/**
 * Deploy a Bankr/Doppler token via Bankr Deploy API.
 * Used by Discord /deploy. Requires BANKR_API_KEY with Agent API (write) access.
 *
 * API: https://docs.bankr.bot/token-launching/deploy-api
 * POST https://api.bankr.bot/token-launches/deploy
 */

import "dotenv/config";

const DEPLOY_API = "https://api.bankr.bot/token-launches/deploy";
const BANKR_API_KEY = process.env.BANKR_API_KEY;

const FEE_RECIPIENT_TYPES = ["wallet", "x", "farcaster", "ens"];

/**
 * Build request body for Bankr deploy API.
 * @param {Object} opts
 * @param {string} opts.tokenName - Required. 1–100 chars.
 * @param {string} [opts.tokenSymbol] - Optional. 1–10 chars. Defaults to first 4 of name.
 * @param {string} [opts.description] - Optional. Max 500 chars.
 * @param {string} [opts.image] - Optional. URL to token logo.
 * @param {string} [opts.websiteUrl] - Optional.
 * @param {string} [opts.tweetUrl] - Optional. Tweet/post URL.
 * @param {{ type: 'wallet'|'x'|'farcaster'|'ens', value: string }} [opts.feeRecipient] - Optional. Defaults to API key wallet.
 * @param {boolean} [opts.simulateOnly] - Optional. Default false.
 */
export function buildDeployBody(opts) {
  const body = {
    tokenName: String(opts.tokenName ?? "").trim(),
    simulateOnly: Boolean(opts.simulateOnly),
  };
  if (!body.tokenName) throw new Error("tokenName is required");

  if (opts.tokenSymbol != null && String(opts.tokenSymbol).trim()) {
    body.tokenSymbol = String(opts.tokenSymbol).trim().slice(0, 10);
  }
  if (opts.description != null && String(opts.description).trim()) {
    body.description = String(opts.description).trim().slice(0, 500);
  }
  if (opts.image != null && String(opts.image).trim()) {
    body.image = String(opts.image).trim();
  }
  if (opts.websiteUrl != null && String(opts.websiteUrl).trim()) {
    body.websiteUrl = String(opts.websiteUrl).trim();
  }
  if (opts.tweetUrl != null && String(opts.tweetUrl).trim()) {
    body.tweetUrl = String(opts.tweetUrl).trim();
  }
  if (opts.feeRecipient?.type && opts.feeRecipient?.value) {
    const type = FEE_RECIPIENT_TYPES.includes(opts.feeRecipient.type)
      ? opts.feeRecipient.type
      : "wallet";
    body.feeRecipient = { type, value: String(opts.feeRecipient.value).trim() };
  }
  return body;
}

/**
 * Parse rate limit headers (if Bankr sends them). Common names: X-RateLimit-Remaining, X-RateLimit-Limit, Retry-After.
 * @returns {{ remaining: number | null, limit: number | null, retryAfterSec: number | null }}
 */
function parseRateLimitHeaders(res) {
  const remaining = res.headers.get("X-RateLimit-Remaining") ?? res.headers.get("x-ratelimit-remaining");
  const limit = res.headers.get("X-RateLimit-Limit") ?? res.headers.get("x-ratelimit-limit");
  const retryAfter = res.headers.get("Retry-After");
  return {
    remaining: remaining != null && remaining !== "" ? parseInt(remaining, 10) : null,
    limit: limit != null && limit !== "" ? parseInt(limit, 10) : null,
    retryAfterSec: retryAfter != null && retryAfter !== "" ? parseInt(retryAfter, 10) : null,
  };
}

/**
 * Call Bankr deploy API.
 * @param {ReturnType<buildDeployBody>} body - From buildDeployBody().
 * @returns {Promise<{ success: boolean, tokenAddress?: string, poolId?: string, txHash?: string, activityId?: string, chain?: string, simulated?: boolean, feeDistribution?: object, rateLimit?: { remaining: number | null, limit: number | null, retryAfterSec: number | null }, error?: string }>}
 */
export async function callBankrDeploy(body) {
  if (!BANKR_API_KEY || !BANKR_API_KEY.trim()) {
    throw new Error("BANKR_API_KEY is not set. Get a key with Agent API access at bankr.bot/api");
  }
  const res = await fetch(DEPLOY_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": BANKR_API_KEY.trim(),
    },
    body: JSON.stringify(body),
  });
  const rateLimit = parseRateLimitHeaders(res);
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    return { ...data, rateLimit };
  }
  const msg = data?.message || data?.error || res.statusText || `HTTP ${res.status}`;
  if (res.status === 401) throw new Error("Invalid API key. Check BANKR_API_KEY.");
  if (res.status === 403) throw new Error("API key must have Agent API (write) access. Enable at bankr.bot/api");
  if (res.status === 429) {
    const parts = [
      "Rate limit exceeded (50 deploys/24h for this key; Bankr Club: 100/24h).",
      rateLimit.retryAfterSec != null ? `Retry after ${rateLimit.retryAfterSec}s.` : "Try again later.",
      "Or deploy at bankr.bot.",
    ];
    throw new Error(parts.join(" "));
  }
  throw new Error(msg || `Deploy failed (${res.status})`);
}
