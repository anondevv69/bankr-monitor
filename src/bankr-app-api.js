/**
 * Small HTTP API for the Bankr Apps control panel.
 *
 * The Bankr App backend scripts call this API with BANKR_APP_API_TOKEN. The
 * user's Bankr wallet address is sent in the request body/query and becomes
 * the config account key.
 */

import { createServer } from "http";
import { getBankrAppUser, setBankrAppUserConfig } from "./bankr-app-store.js";
import { sendBankrAppTestDiscordWebhook } from "./bankr-app-notify.js";
import { lookupByDeployerOrFee, resolveHandleToWallet } from "./lookup-deployer.js";
import { defaultBankrApiKey } from "./bankr-env-key.js";

let serverStarted = false;

function json(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, authorization, x-bankr-app-token",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(body));
}

function parseAuthToken(req) {
  const bearer = req.headers.authorization || "";
  if (bearer.toLowerCase().startsWith("bearer ")) return bearer.slice(7).trim();
  return String(req.headers["x-bankr-app-token"] || "").trim();
}

function requireAuth(req, res) {
  const expected = String(process.env.BANKR_APP_API_TOKEN || "").trim();
  if (!expected) {
    json(res, 503, { ok: false, error: "BANKR_APP_API_TOKEN is not configured on Railway." });
    return false;
  }
  const got = parseAuthToken(req);
  if (!got || got !== expected) {
    json(res, 401, { ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

function walletFromUrlOrBody(url, body) {
  return (
    body?.walletAddress ||
    body?.wallet ||
    body?.callerWallet ||
    url.searchParams.get("walletAddress") ||
    url.searchParams.get("wallet") ||
    null
  );
}

function isValidWalletLike(value) {
  const s = String(value ?? "").trim();
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Body too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

async function handleConfigGet(req, res, url) {
  if (!requireAuth(req, res)) return;
  const walletAddress = walletFromUrlOrBody(url, null);
  if (!isValidWalletLike(walletAddress)) {
    json(res, 400, { ok: false, error: "walletAddress is required" });
    return;
  }
  const user = await getBankrAppUser(walletAddress);
  json(res, 200, { ok: true, user });
}

async function handleConfigPost(req, res, url) {
  if (!requireAuth(req, res)) return;
  const body = await readJson(req);
  const walletAddress = walletFromUrlOrBody(url, body);
  if (!isValidWalletLike(walletAddress)) {
    json(res, 400, { ok: false, error: "walletAddress is required" });
    return;
  }
  const user = await setBankrAppUserConfig(walletAddress, {
    destinations: body.destinations,
    watchlist: body.watchlist,
    settings: body.settings,
  });
  json(res, 200, { ok: true, user });
}

async function handleTestDestination(req, res, url) {
  if (!requireAuth(req, res)) return;
  const body = await readJson(req);
  const walletAddress = walletFromUrlOrBody(url, body);
  if (!isValidWalletLike(walletAddress)) {
    json(res, 400, { ok: false, error: "walletAddress is required" });
    return;
  }
  const existing = await getBankrAppUser(walletAddress);
  const webhookUrl = body?.destinations?.discordWebhookUrl || body?.discordWebhookUrl || existing?.destinations?.discordWebhookUrl;
  if (!webhookUrl) {
    json(res, 400, { ok: false, error: "discordWebhookUrl is required" });
    return;
  }
  await sendBankrAppTestDiscordWebhook(webhookUrl, walletAddress);
  json(res, 200, { ok: true });
}

async function handleWalletLookup(req, res, url) {
  if (!requireAuth(req, res)) return;
  const body = await readJson(req);
  const query = String(body.query || url.searchParams.get("query") || "").trim();
  if (!query) {
    json(res, 400, { ok: false, error: "query is required" });
    return;
  }
  const apiKey = defaultBankrApiKey(body.bankrApiKey);
  const resolved = await resolveHandleToWallet(query, { bankrApiKey: apiKey });
  let lookup = null;
  if (resolved.wallet) {
    const result = await lookupByDeployerOrFee(resolved.wallet, "both", "newest", { bankrApiKey: apiKey });
    lookup = {
      totalCount: result.totalCount,
      shown: result.matches?.length ?? 0,
      searchUrl: result.searchUrl,
      matches: (result.matches || []).slice(0, 10).map((m) => ({
        name: m.name,
        symbol: m.symbol,
        tokenAddress: m.tokenAddress,
        launcher: m.launcher,
        launcherX: m.launcherX,
        deployedAtMsFromBankr: m.deployedAtMsFromBankr ?? null,
      })),
    };
  }
  json(res, 200, { ok: true, resolved, lookup });
}

function routeNotFound(res) {
  json(res, 404, {
    ok: false,
    error: "Not found",
    routes: ["/health", "/api/app/config", "/api/app/test-destination", "/api/app/wallet-lookup"],
  });
}

export function startBankrAppApiServer() {
  if (serverStarted) return null;
  serverStarted = true;
  const port = parseInt(process.env.PORT || process.env.BANKR_APP_API_PORT || "3899", 10);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const path = url.pathname.replace(/\/$/, "") || "/";
      if (req.method === "OPTIONS") {
        json(res, 204, {});
        return;
      }
      if (req.method === "GET" && path === "/health") {
        json(res, 200, { ok: true, service: "bankr-monitor", appApi: true });
        return;
      }
      if (req.method === "GET" && path === "/api/app/config") {
        await handleConfigGet(req, res, url);
        return;
      }
      if (req.method === "POST" && path === "/api/app/config") {
        await handleConfigPost(req, res, url);
        return;
      }
      if (req.method === "POST" && path === "/api/app/test-destination") {
        await handleTestDestination(req, res, url);
        return;
      }
      if (req.method === "POST" && path === "/api/app/wallet-lookup") {
        await handleWalletLookup(req, res, url);
        return;
      }
      routeNotFound(res);
    } catch (e) {
      json(res, 500, { ok: false, error: e?.message ?? String(e) });
    }
  });
  server.listen(port, () => {
    console.log(`BankrMonitor app API listening on port ${port}`);
  });
  return server;
}

