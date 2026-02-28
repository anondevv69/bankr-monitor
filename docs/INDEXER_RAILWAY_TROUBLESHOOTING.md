# Indexer on Railway: "Application failed to respond" / 502

When your indexer URL (e.g. `https://natural-embrace-production-07b7.up.railway.app/graphql`) shows **"Application failed to respond"** or **502**, the build often succeeded but the **runtime** process is failing or not listening on the right port.

## 1. Check Deploy Logs (not Build Logs)

- In Railway → your **indexer service** → open **Deploy Logs** (the tab that shows output **after** the build, when the app is running).
- **Build Logs** only show `pnpm install` and `pnpm run start` starting; they don’t show why the app crashes or never binds to the port.
- Look for:
  - **Missing env:** `DATABASE_URL is not defined`, `PONDER_RPC_URL_8453`, etc.
  - **DB connection:** `connection refused`, `timeout`, `password authentication failed`
  - **Port:** `EADDRINUSE` or “listening on port X” (if it says a port other than Railway’s `PORT`, that’s the bug).
  - **Ponder errors:** schema errors, “chain X has no RPC”, etc.

Paste the **last 50–100 lines of Deploy Logs** into your notes or share them (redact secrets) so you can see the exact error.

## 2. Start command must use Railway’s PORT

Railway injects **`PORT`** (e.g. `3000`). Your app **must** listen on that port or the proxy will get no response and show “Application failed to respond”.

In the **indexer** repo (doppler-indexer), the start command should pass the port to Ponder. In Railway → indexer service → **Settings** → **Deploy** → **Custom Start Command**, use something like:

```bash
pnpm start --config ./ponder.config.multicurve.ts --schema $RAILWAY_DEPLOYMENT_ID -p $PORT
```

If your `package.json` script is already `ponder start ...` without `-p $PORT`, then either:

- Change the **Custom Start Command** to the full command above (with `-p $PORT`), or  
- In the indexer repo, change the `start` script to include `-p ${PORT:-42069}` (or `-p $PORT`) so the process listens on Railway’s `PORT`.

After changing the start command, redeploy and check **Deploy Logs** again for “listening on port …” and any crash.

## 3. 429 rate limit (Alchemy / RPC) — ELIFECYCLE exit code 1

If Deploy Logs show **429** from Alchemy ("Your app has exceeded its compute units per second capacity") and then **"All JSON-RPC providers are inactive"** and the process exits with **ELIFECYCLE exit code 1**, the indexer is hitting the RPC rate limit during backfill and crashing.

**What to do:**

1. **Use a paid or higher-tier RPC** — Alchemy free tier has limited compute units per second. For full backfill, use a dedicated Base RPC with higher limits (e.g. Alchemy Growth, QuickNode, Infura) and set it in **`PONDER_RPC_URL_8453`**.
2. **Add a fallback RPC** — If the indexer config supports multiple transports for Base, add a second URL so when the first returns 429, the other is used.
3. **Start from a later block** — If you only need recent data, change the config so Base backfill starts from a more recent block (fewer RPC calls, fewer 429s).
4. **Throttle** — If Ponder or the config allows tuning (max concurrent requests, delay), lower concurrency to stay under the provider's limits.

Until 429s are under control, the indexer will keep exiting with code 1 and the deploy will show "Application failed to respond".

## 3b. Index only Bankr (not Doppler, Ohara, Long, Duels, etc.)

The **multicurve** config (`ponder.config.multicurve.ts`) in the **doppler-indexer** repo usually defines contracts for many apps: Doppler, Ohara, Long, Duels, Coop Records, Paragraph, FXhash, zora, Bankr, etc. So the indexer is syncing **all of them** — that’s why you see so many RPC calls and 429s.

**To index only Bankr tokens:**

1. Open your **indexer repo** (doppler-indexer fork), not BankrMonitor.
2. Edit **`ponder.config.multicurve.ts`** (or the config file you use):
   - **Option A:** Create a **Bankr-only config** (e.g. `ponder.config.bankr.ts`) that only registers the contracts/chains Bankr uses (e.g. Rehype Doppler hook, relevant pool factories on Base). Remove or don’t include Ohara, Long, Duels, Paragraph, FXhash, zora, generic Doppler, etc.
   - **Option B:** In the existing multicurve config, **comment out or remove** every `contract` / `network` block that isn’t needed for Bankr (keep only Base and the Rehype/Doppler hooks and factories that Bankr uses).
3. Start the indexer with that config, e.g.  
   `ponder start --config ./ponder.config.bankr.ts ...`  
   or your trimmed multicurve config.

That way the indexer only fetches logs for Bankr-relevant contracts, which cuts RPC load and helps avoid 429s. BankrMonitor only needs the indexer to expose **tokens**, **v4pools** (or **pools**), and **cumulatedFees** for Base; you don’t need other apps in the config.

## 4. Port: log says port=8080 but Railway expects PORT

If the log says **`Created HTTP server port=8080`** but Railway injects a different **`PORT`** (e.g. 3000), the proxy won't reach the app. Ensure the start command actually uses Railway's port. If **`$PORT`** isn't expanded (e.g. wrong shell), try:

```bash
sh -c 'ponder start --config ./ponder.config.multicurve.ts --schema default -p ${PORT:-3000}'
```

In Railway Variables, don't override **`PORT`**; let Railway set it.

## 5. Required environment variables (indexer service)

In Railway → indexer service → **Variables**:

| Variable | Required | Notes |
|----------|----------|--------|
| `DATABASE_URL` | Yes | From **Add Reference** → Postgres service → `DATABASE_URL`. |
| `PONDER_RPC_URL_8453` | Yes (for Base) | Base mainnet RPC. Use a dedicated key (e.g. Alchemy/QuickNode) to avoid 429s. |
| `PONDER_RPC_URL_1` | If config needs it | ETH mainnet for price feeds, etc. |

If the config uses other chains, add the corresponding `PONDER_RPC_URL_<chainId>` or make those chains optional so the app doesn’t crash on missing RPC.

## 6. Healthcheck

In **Settings** → **Deploy**:

- **Healthcheck Path:** `/ready`
- **Healthcheck Timeout:** `3600` (Ponder can take a long time to sync; a short timeout can mark the deploy as failed even when the app is still starting.)

## 7. Quick checklist

- [ ] **Deploy Logs** opened and error/crash message found.
- [ ] **Custom Start Command** includes `-p $PORT` (or the app otherwise binds to `PORT`).
- [ ] **DATABASE_URL** set (reference to Postgres).
- [ ] **PONDER_RPC_URL_8453** (and any other RPC URLs the config needs) set.
- [ ] **Healthcheck Timeout** at least 3600 if the indexer takes long to become ready.

Once the process stays up and listens on `PORT`, `https://your-indexer.up.railway.app/graphql` should respond. Then set **BankrMonitor**’s `DOPPLER_INDEXER_URL` to that base URL (no trailing slash).
