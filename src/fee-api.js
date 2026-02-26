#!/usr/bin/env node
/**
 * Minimal stateless fee API: on-chain reads only, no Postgres, no full indexer.
 *
 * GET /claimable?pool=<poolId>           — Rehype hook beneficiary fees for pool (Base only).
 * GET /claimable?token=<assetAddress>    — Resolve poolId + fee recipient via Bankr, then hook fees.
 * GET /health                            — For Railway/Render/Fly health checks.
 *
 * Optional: in-memory cache 60s (claimable responses). Set PORT (default 3xxx).
 *
 * Env: RPC_URL or RPC_URL_BASE (Base RPC). BANKR_API_KEY for ?token= resolution.
 */

import "dotenv/config";
import { createServer } from "http";
import { fetchHookFeesOnChain, getTokenFees, CHAIN_ID } from "./token-stats.js";

const PORT = parseInt(process.env.PORT || "3899", 10);
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

const cache = new Map(); // key -> { data, expires }

function normalizePoolId(poolId) {
  if (!poolId || typeof poolId !== "string") return null;
  const s = poolId.trim();
  return /^0x[a-fA-F0-9]{64}$/.test(s) ? s : null;
}

function normalizeAddress(addr) {
  if (!addr || typeof addr !== "string") return null;
  const s = addr.trim();
  return /^0x[a-fA-F0-9]{40}$/.test(s) ? s.toLowerCase() : null;
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expires) {
    if (entry) cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data) {
  cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

function send(res, statusCode, body, contentType = "application/json") {
  res.writeHead(statusCode, { "Content-Type": contentType });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function handleClaimableByPool(poolId) {
  const hookFees = await fetchHookFeesOnChain(poolId);
  if (!hookFees) {
    return {
      ok: false,
      error: "Not a Rehype pool or RPC failed",
      poolId,
      chainId: CHAIN_ID,
    };
  }
  const decimals = 18;
  return {
    ok: true,
    poolId,
    chainId: CHAIN_ID,
    beneficiaryFees: {
      token0: hookFees.beneficiaryFees0.toString(),
      token1: hookFees.beneficiaryFees1.toString(),
      token0Formatted: Number(hookFees.beneficiaryFees0) / 10 ** decimals,
      token1Formatted: Number(hookFees.beneficiaryFees1) / 10 ** decimals,
    },
    totalFees: {
      token0: hookFees.fees0.toString(),
      token1: hookFees.fees1.toString(),
    },
    note: "Beneficiary share is pool-level (all beneficiaries). For per-address claimable use indexer or Bankr terminal.",
  };
}

async function handleClaimableByToken(tokenAddress) {
  const out = await getTokenFees(tokenAddress);
  const poolId = typeof out.launch?.poolId === "string" ? out.launch.poolId.trim() : null;
  if (!poolId) {
    return {
      ok: false,
      error: out.error || "No Bankr launch or poolId",
      tokenAddress,
      chainId: CHAIN_ID,
    };
  }
  const hookFees = out.hookFees;
  const feeWallet = out.feeWallet ?? null;
  if (!hookFees) {
    return {
      ok: true,
      tokenAddress,
      name: out.name,
      symbol: out.symbol,
      poolId,
      feeRecipient: feeWallet,
      chainId: CHAIN_ID,
      beneficiaryFees: null,
      error: "On-chain hook fees not available (not Rehype or RPC failed).",
    };
  }
  const decimals = 18;
  return {
    ok: true,
    tokenAddress,
    name: out.name,
    symbol: out.symbol,
    poolId,
    feeRecipient: feeWallet,
    chainId: CHAIN_ID,
    beneficiaryFees: {
      token0: hookFees.beneficiaryFees0.toString(),
      token1: hookFees.beneficiaryFees1.toString(),
      token0Formatted: Number(hookFees.beneficiaryFees0) / 10 ** decimals,
      token1Formatted: Number(hookFees.beneficiaryFees1) / 10 ** decimals,
    },
    totalFees: {
      token0: hookFees.fees0.toString(),
      token1: hookFees.fees1.toString(),
    },
    note: "Beneficiary share is pool-level. You can query any token; fee recipient claims via Bankr terminal or collectFees.",
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname.replace(/\/$/, "") || "/";
  const method = req.method;

  if (method !== "GET") {
    send(res, 405, { error: "Method not allowed" });
    return;
  }

  if (path === "/health") {
    send(res, 200, { ok: true, service: "fee-api", chainId: CHAIN_ID });
    return;
  }

  if (path === "/claimable") {
    const pool = url.searchParams.get("pool");
    const token = url.searchParams.get("token");
    if (pool) {
      const poolId = normalizePoolId(pool);
      if (!poolId) {
        send(res, 400, { error: "Invalid pool (expect 0x + 64 hex)" });
        return;
      }
      const cached = cacheGet(`pool:${poolId}`);
      if (cached) {
        send(res, 200, cached);
        return;
      }
      const data = await handleClaimableByPool(poolId);
      cacheSet(`pool:${poolId}`, data);
      send(res, 200, data);
      return;
    }
    if (token) {
      const tokenAddress = normalizeAddress(token);
      if (!tokenAddress) {
        send(res, 400, { error: "Invalid token (expect 0x + 40 hex)" });
        return;
      }
      const cached = cacheGet(`token:${tokenAddress}`);
      if (cached) {
        send(res, 200, cached);
        return;
      }
      const data = await handleClaimableByToken(tokenAddress);
      cacheSet(`token:${tokenAddress}`, data);
      send(res, 200, data);
      return;
    }
    send(res, 400, {
      error: "Use ?pool=<poolId> or ?token=<assetAddress>",
      example: "/claimable?token=0x40d5fef68d07ec540e95a1e6630906b6de6a9ba3",
    });
    return;
  }

  send(res, 404, { error: "Not found", routes: ["/health", "/claimable"] });
});

server.listen(PORT, () => {
  console.log(`Fee API listening on port ${PORT}`);
  console.log(`  GET /health`);
  console.log(`  GET /claimable?pool=<poolId> | /claimable?token=<assetAddress>`);
});
