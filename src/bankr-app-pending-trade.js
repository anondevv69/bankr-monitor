/**
 * Queue native auto-buy requests for Bankr App scripts (no Agent API keys on Railway).
 */

import { randomBytes } from "crypto";
import { getBankrAppUser, setBankrAppUserConfig } from "./bankr-app-store.js";

const PENDING_TTL_MS = Math.max(
  5 * 60_000,
  parseInt(process.env.BANKR_APP_PENDING_TRADE_TTL_MS || String(30 * 60_000), 10)
);

function normAddr(addr) {
  const s = String(addr ?? "").trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(s) ? s : null;
}

function normalizePendingTrade(raw) {
  if (!raw || typeof raw !== "object") return null;
  const tokenAddress = normAddr(raw.tokenAddress);
  if (!tokenAddress) return null;
  const status = String(raw.status || "pending");
  if (status !== "pending") return null;
  const createdAtMs = raw.createdAtMs != null ? Number(raw.createdAtMs) : Date.parse(raw.createdAt || "");
  if (!Number.isFinite(createdAtMs)) return null;
  if (Date.now() - createdAtMs > PENDING_TTL_MS) return null;
  const amount = Number(raw.amountUsdc);
  return {
    id: String(raw.id || `pt-${tokenAddress.slice(2, 10)}`),
    status: "pending",
    tokenAddress,
    name: raw.name != null ? String(raw.name).slice(0, 120) : null,
    symbol: raw.symbol != null ? String(raw.symbol).slice(0, 32) : null,
    amountUsdc: Number.isFinite(amount) ? amount : 1,
    takeProfitPct: raw.takeProfitPct != null ? Number(raw.takeProfitPct) : null,
    stopLossPct: raw.stopLossPct != null ? Number(raw.stopLossPct) : null,
    bankrUrl: raw.bankrUrl || `https://bankr.bot/launches/${tokenAddress}`,
    marketCapFormatted: raw.marketCapFormatted ?? null,
    buys30m: raw.buys30m ?? null,
    buys5m: raw.buys5m ?? null,
    buys1h: raw.buys1h ?? null,
    createdAt: new Date(createdAtMs).toISOString(),
    createdAtMs,
  };
}

export async function getPendingTradeForWallet(walletAddress) {
  const user = await getBankrAppUser(walletAddress);
  return normalizePendingTrade(user?.pendingTrade);
}

export async function queuePendingTradeForUser(user, launch, hotStats = {}) {
  if (!user?.autoTrade?.enabled) return null;
  const tokenAddress = normAddr(launch?.tokenAddress);
  if (!tokenAddress) return null;

  const existing = normalizePendingTrade(user.pendingTrade);
  if (existing?.tokenAddress === tokenAddress) return existing;

  const auto = user.autoTrade;
  const pendingTrade = {
    id: `pt-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`,
    status: "pending",
    tokenAddress,
    name: launch?.name ?? launch?.tokenName ?? null,
    symbol: launch?.symbol ?? launch?.tokenSymbol ?? null,
    amountUsdc: auto.amountUsdc ?? 1,
    takeProfitPct: auto.takeProfitPct ?? 50,
    stopLossPct: auto.stopLossPct ?? 20,
    bankrUrl: `https://bankr.bot/launches/${tokenAddress}`,
    marketCapFormatted: hotStats?.marketCapFormatted ?? null,
    buys30m: hotStats?.buys30m ?? null,
    buys5m: hotStats?.buys5m ?? null,
    buys1h: hotStats?.buys1h ?? null,
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
  };

  await setBankrAppUserConfig(user.userId || user.walletAddress, { pendingTrade });
  console.log(
    `[bankr-app] pending trade queued wallet=${String(user.userId || user.walletAddress).slice(0, 8)}… token=${tokenAddress.slice(0, 8)}…`
  );
  return pendingTrade;
}

export async function ackPendingTradeForWallet(walletAddress, { tradeId, status } = {}) {
  const user = await getBankrAppUser(walletAddress);
  const pending = normalizePendingTrade(user?.pendingTrade);
  if (!pending) return { ok: true, cleared: false };
  if (tradeId && pending.id !== tradeId) {
    return { ok: false, error: "tradeId does not match active pending trade" };
  }
  const nextStatus = String(status || "dismissed");
  await setBankrAppUserConfig(walletAddress, {
    pendingTrade: {
      ...pending,
      status: nextStatus === "confirmed" ? "confirmed" : "dismissed",
      clearedAt: new Date().toISOString(),
    },
  });
  await setBankrAppUserConfig(walletAddress, { pendingTrade: null });
  return { ok: true, cleared: true, status: nextStatus };
}
