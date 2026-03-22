# BankrMonitor

Fetch and monitor tokens deployed via [Bankr](https://bankr.bot) on Base. Bankr uses the [Doppler](https://doppler.lol) protocol for token launches (Uniswap V4 pools).

The [bankr.bot/launches](https://bankr.bot/launches) feed shows real-time token deployments with metadata: launcher, fee recipient, contract address, name, X/website links. This project provides alternative data sources when you need to fetch launches programmatically.

---

## Ready to share: checklist

Once these are done, you can invite the bot to many servers and let each server run **/setup full** (or **/setup api_key** + **/setup channels**) with their own API key, rules, and alert watchlist.

| Step | What to do |
|------|-------------|
| **1. Deploy Doppler indexer** | Run the [doppler-indexer](https://github.com/whetstoneresearch/doppler-indexer) on Railway (Postgres + indexer service). See **Self-hosting the Doppler indexer on Railway** below. |
| **2. Set BankrMonitor env** | In the place where the bot runs (Railway, VPS, or `.env`): `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DOPPLER_INDEXER_URL` (your indexer URL), `RPC_URL` (Base RPC), and optionally `BANKR_API_KEY` (so /lookup and paste/mention fee replies work without 403). |
| **3. Run the bot** | `npm start` (or deploy the Discord bot service). Optional: run `npm run fee-api` if you want the claimable-fees API. |
| **4. Share** | Invite the bot to servers. Each server runs **/setup full** (or subcommands) and **/alert-watchlist add** for wallets/keywords. Use **/setup show** / **/setup channels** / **/setup rules** to edit. |

Verify the indexer: `DOPPLER_INDEXER_URL=https://your-indexer.up.railway.app npm run check:indexer` should show OK.

**Persist Discord /setup across redeploys (Railway):** By default the bot stores per-server config in `.bankr-tenants.json` in the app root. On Railway the filesystem is **ephemeral** — it’s wiped on every deploy, so you’d have to run **/setup** again after each deploy. To keep settings:

1. In your **BankrMonitor (bot)** service on Railway, go to **Settings → Volumes → Add Volume**, set mount path **`/data`**.
2. In **Variables**, add: **`TENANTS_FILE=/data/bankr-tenants.json`**
3. Redeploy. The tenants file will live on the volume and survive future deploys. Optionally set **`SEEN_FILE=/data/bankr-seen.json`** and **`WATCH_FILE=/data/bankr-watch.json`** so the launch “seen” list and global watch list also persist.

For full Railway + volume details see [docs/RAILWAY_AND_TENANT_STORAGE.md](docs/RAILWAY_AND_TENANT_STORAGE.md).

---

## Data Sources

Fetch order: **Bankr API** (when `BANKR_API_KEY` set) → **Doppler Indexer** → **Chain** (Airlock events).

### 1. Bankr API (recommended)

`GET https://api.bankr.bot/token-launches` with `X-API-Key`. Returns Bankr-only launches (Base mainnet). No RPC, no rate limits. Get a key at [bankr.bot/api](https://bankr.bot/api).

### 2. Doppler Indexer (GraphQL)

The [Doppler Indexer](https://docs.doppler.lol/indexer/overview) indexes Doppler protocol contracts and tokens on Base.

| Endpoint | Chain |
|----------|-------|
| https://testnet-indexer.doppler.lol | Base Sepolia (testnet) |
| https://bankr.indexer.doppler.lol | Base (mainnet) — **default** in BankrMonitor (Bankr indexer) |
| https://indexer-prod.doppler.lol | Base (mainnet) — alternate; set `DOPPLER_INDEXER_URL` if you use it |
| https://indexer.doppler.lol | Base (mainnet) — legacy public endpoint, often 502 |

If **fees** show “No fee data yet” but the token has a pool and fee recipient, ensure **DOPPLER_INDEXER_URL** is set (e.g. **https://bankr.indexer.doppler.lol**). If the indexer returns 502, it’s down or overloaded; use a [self-hosted indexer](https://github.com/whetstoneresearch/doppler-indexer) if needed.

BankrMonitor defaults to **https://bankr.indexer.doppler.lol** for Base mainnet. To only show Bankr tokens from the indexer, it filters by **integration address** `0xF60633D02690e2A15A54AB919925F3d038Df163e` (configurable via `BANKR_INTEGRATION_ADDRESS`). For **/fees** and volume you can override `DOPPLER_INDEXER_URL` with your own indexer (e.g. [doppler-indexer on Railway](https://github.com/whetstoneresearch/doppler-indexer)).

**Pros:** Token metadata, launcher address (`creatorAddress`), volume, holder count, `cumulatedFees` (for /fees). Filter by integration/beneficiary so only Bankr tokens appear in the feed.  
**Cons:** No Bankr-specific launcher X handles (those come from Bankr’s own mapping).

#### Indexer API Reference

The indexer exposes data via **GraphQL** (`/graphql`) and **REST** (`/search/:query`).

**GraphQL** — strongly typed; supports queries, filtering, pagination.

Example: top pools by USD liquidity:

```graphql
query TopPoolsByLiquidity {
  pools(where: { chainId: 8453 }, orderBy: "dollarLiquidity", orderDirection: "desc", limit: 5) {
    address
    dollarLiquidity
    volumeUsd
    baseToken { symbol }
    quoteToken { symbol }
  }
}
```

Example: token details:

```graphql
query TokenDetails {
  token(id: "0x...") {
    address name symbol decimals image volumeUsd holderCount
    pool { address price }
  }
}
```

### Token trend card (indexer-only JSON + text)

[`src/token-trend-card.js`](src/token-trend-card.js) builds a compact **trend card** from the Bankr indexer: pool stats, 15m volume buckets, swap aggregates, a 0–100 **trend score** (momentum, volume acceleration, traders, buy pressure), and labels **NOT_TRENDING / WARM / TRENDING / HOT**. Use from code (`buildTokenTrendCard`) or CLI:

```bash
npm run trend-card -- 0xYourToken…ba3
npm test   # includes test/token-trend-card.test.js
```

**REST** — search tokens by name, symbol, or address:

```bash
# Search by name/symbol on Base
curl "https://testnet-indexer.doppler.lol/search/doppler?chain_ids=8453"
# Search by address
curl "https://testnet-indexer.doppler.lol/search/0x123...abc?chain_ids=8453,57073"
```

**Direct SQL (self-hosted indexer only)** — `pnpm db shell` for psql; use the connection string from `.env.local`.

**Why fees show $0.00 / “no volume”**

- **Estimated creator fees** = indexer’s `volumeUsd` × 1.2% × 57%. If the indexer has no volume (or `0`) for that token, the estimate is $0. New or not-yet-indexed tokens often have no volume.
- **Historical accrued** = indexer’s `cumulatedFees(poolId, chainId, beneficiary)`. If the indexer has no row for that pool/beneficiary yet, nothing is shown.
- **Claimable right now** = on-chain `RehypeDopplerHook.getHookFees(poolId)`. This is **not** from the indexer. Set **RPC_URL_BASE** (Base RPC) in the bot’s environment so the bot can read the hook; then claimable token/WETH for the fee recipient will appear in **paste/mention** fee replies (or `token-stats` / fee API).

**What tokens does the indexer have?**

The indexer has a token once it has seen that token’s pool (e.g. from a create/migrate event) and may add volume when swaps are indexed. To list tokens that have data on Base:

```bash
# Optional: use your indexer URL
export DOPPLER_INDEXER_URL=https://bankr.indexer.doppler.lol

# List tokens with volume (GraphQL)
curl -s -X POST "${DOPPLER_INDEXER_URL%/}/graphql" -H "Content-Type: application/json" \
  -d '{"query":"query { tokens(where: { chainId: 8453, volumeUsd_gt: \"0\" }, orderBy: \"volumeUsd\", orderDirection: \"desc\", limit: 20) { items { address name symbol volumeUsd } } }"}' | jq .
```

If your indexer schema uses different field names (e.g. `volumeUsd_gt` vs `volumeUsdGt`), check its GraphQL schema or docs. The bot uses `tokens(where: { chainId, address })` to fetch one token; when the indexer has that token, volume and pool are used for estimates and for resolving the pool id when the Bankr API doesn’t return it.

**Indexer events** (what Ponder indexes): `UniswapV3Initializer.Create`, `UniswapV4Initializer.Create`, `Airlock.Migrate`, `UniswapV2Pair.Swap`, pool `Mint`/`Burn`/`Swap`, `DERC20.Transfer`. Supported chains: Base (8453), Base Sepolia (84532), Unichain (130), Ink (57073).

#### Self-hosting the Doppler indexer on Railway

To get reliable volume and (if you add it) cumulated fees, you can self-host the [doppler-indexer](https://github.com/whetstoneresearch/doppler-indexer) (Ponder) on [Railway](https://railway.app/) and point BankrMonitor at your own GraphQL endpoint.

**1. Repo and DB**

- Fork or clone [whetstoneresearch/doppler-indexer](https://github.com/whetstoneresearch/doppler-indexer).
- In Railway: **New Project** → **Deploy from GitHub repo** → select your `doppler-indexer` repo.
- In the same project: **Add service** → **Database** → **PostgreSQL**. Railway will create a Postgres instance and expose `DATABASE_URL`.

**2. Use `DATABASE_URL` in the indexer**

The multicurve config hardcodes a local Postgres URL. So that the app uses Railway’s Postgres, make the connection string env-driven. In your fork, in `ponder.config.multicurve.ts`, set the database config to:

```ts
database: {
  kind: "postgres",
  connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/default",
  poolConfig: { max: 100 },
},
```

Commit and push so Railway redeploys.

**3. Railway variables**

In the **indexer service** (not the DB), open **Variables** and set:

| Variable | Value |
|----------|--------|
| `DATABASE_URL` | Reference: click **New Variable** → **Add Reference** → choose the Postgres service’s `DATABASE_URL`. |
| `PONDER_RPC_URL_8453` | Base mainnet RPC (e.g. `https://mainnet.base.org` or Alchemy/QuickNode for better rate limits). |
| `PONDER_RPC_URL_1` | Ethereum mainnet RPC (used for ETH price; e.g. Alchemy). |

Optional, if you use other chains in that config: `PONDER_RPC_URL_84532`, `PONDER_RPC_URL_130`, etc.

**4. Build and start command**

- **Build:** Railway usually detects `pnpm` from the repo. If not, set **Build Command** to `pnpm install`.
- **Start:** In the indexer service, **Settings** → **Deploy** → **Custom Start Command**:

```bash
pnpm start --config ./ponder.config.multicurve.ts --schema $RAILWAY_DEPLOYMENT_ID -p $PORT
```

- `--config ./ponder.config.multicurve.ts` — run the multicurve setup (Base + other chains in that file).
- `--schema $RAILWAY_DEPLOYMENT_ID` — recommended by [Ponder’s Railway guide](https://ponder.sh/docs/production/railway) for schema isolation per deployment.
- `-p $PORT` — listen on Railway’s assigned port so the HTTP/GraphQL server is reachable.

**5. Healthcheck**

In **Settings** → **Deploy**: set **Healthcheck Path** to `/ready` and **Healthcheck Timeout** to `3600` (Ponder can take a while to sync).

**6. Public URL**

In **Settings** → **Networking**, click **Generate Domain**. You’ll get a URL like `https://your-app.up.railway.app`. GraphQL is at `https://your-app.up.railway.app/graphql`.

**7. Point BankrMonitor at your indexer**

In the environment where BankrMonitor runs (e.g. Railway app service or `.env`), set:

```bash
DOPPLER_INDEXER_URL=https://your-app.up.railway.app
```

Then `token-stats`, `notify`, and any script that uses the indexer will use your instance for volume (and for cumulated fees if you add that to the indexer schema).

**What BankrMonitor actually uses:** Only **`/graphql`** (POST) and, as fallback, **`/search/:address`** (GET). The root `/` and **`/ready`** are not used for fee or token data — they may be empty or 404 on your indexer; that’s fine. As long as **`/graphql`** returns 200 and valid GraphQL (e.g. `tokens`, `v4pools`, `cumulatedFees`), the bot will use the indexer.

**Check that the indexer is working:**

```bash
# In .env set:
# DOPPLER_INDEXER_URL=https://natural-embrace-production-07b7.up.railway.app

npm run check:indexer
# Or with a custom URL (no trailing slash):
DOPPLER_INDEXER_URL=https://natural-embrace-production-07b7.up.railway.app npm run check:indexer
```

This hits **`/ready`** (optional health) and **`/graphql`** (one token query). If **`/graphql`** shows **OK**, the indexer is usable. If you see **502** or “application failed to respond” on `/` or `/ready`, the indexer app on Railway may be crashing or not listening — check the **indexer service’s deploy logs** in Railway and ensure the start command and `PORT` are correct. Once **`/graphql`** responds with 200 and data, BankrMonitor will use it for volume and cumulated fees. For a step-by-step fix when the indexer returns 502 or "application failed to respond", see **[Indexer Railway troubleshooting](docs/INDEXER_RAILWAY_TROUBLESHOOTING.md)**.

**Optional:** Add a `cumulatedFees` (and pools-by-base-token) API in your indexer fork so token-stats can show claimable-style fees; the BankrMonitor side already calls the shape we added earlier.

#### Lightweight fee API (no indexer, no Postgres)

If you only need **fee + pool analytics** (e.g. “how much is claimable?”) and want minimal storage and maintenance, you can skip the full [doppler-indexer](https://github.com/whetstoneresearch/doppler-indexer) and run a **stateless fee API** that uses Base RPC on-demand:

- **No Postgres**, no block syncing, no swap indexing.
- **On-chain reads only:** RehypeDopplerHook `getHookFees(poolId)` for beneficiary fee totals (Rehype/Bankr pools on Base).
- Optional **in-memory cache** (60s) to avoid hammering RPC.

**Run the fee API:**

```bash
npm run fee-api
# Listens on PORT (default 3899). Requires RPC_URL or RPC_URL_BASE for Base.
```

**Endpoints:**

| Route | Query | Description |
|-------|--------|-------------|
| `GET /health` | — | Health check (Railway/Render/Fly). |
| `GET /claimable` | `?pool=<poolId>` | Beneficiary fees for pool (0x + 64 hex). |
| `GET /claimable` | `?token=<assetAddress>` | Resolve poolId + fee recipient via Bankr, then hook fees. |

**Example:**

```bash
curl "http://localhost:3899/claimable?token=0x40d5fef68d07ec540e95a1e6630906b6de6a9ba3"
```

**Deploy on Railway:** Add a service that runs `node src/fee-api.js`, set `PORT` (Railway provides it), and `RPC_URL` or `RPC_URL_BASE` (e.g. Alchemy/QuickNode Base RPC). Optionally set `BANKR_API_KEY` for reliable `?token=` resolution. Generate a domain in Networking. No database required.

**When to use the full indexer instead:** Use [doppler-indexer](https://github.com/whetstoneresearch/doppler-indexer) if you need volume charts, OHLC, leaderboards, historical performance, or per-beneficiary **cumulatedFees** from indexed events. For “how much is claimable right now?” the stateless API is enough.

### 3. Direct Chain Indexing

Index Doppler **Airlock** `Create` events on Base. Bankr deploys via Doppler; each token creation emits `Create(asset, ...)`. Fetches token metadata (name, symbol, tokenURI) for X/website links.

**Pros:** Direct signal from Bankr’s deployment path; works whenever RPC is available  
**Cons:** Requires RPC URL; Alchemy free tier limits `getLogs` to 10 blocks per request

The notify loop uses **incremental scanning** (persists last block in `.bankr-last-block.json`), so after the first run it only scans new blocks (~20 RPC calls per 5‑min poll instead of ~500).

### 4. Bankr Deploy API (create tokens only)

Bankr has a [Token Deploy API](https://docs.bankr.bot/token-launching/deploy-api) for **creating** tokens. API keys from [bankr.bot/api](https://bankr.bot/api) also work for **listing** launches via `GET /token-launches` (see source 1 above).

## Lookup: tokens by wallet, X, or Farcaster

**Token stats (volume + fee estimate for any token):**

```bash
npm run token-stats -- 0x9b40e8d9dda89230ea0e034ae2ef0f435db57ba3
```

Uses the Bankr API (launch metadata: deployer, fee recipient) and optional Doppler indexer (trading volume). Set `BANKR_API_KEY` in `.env` so the single-token launch endpoint does not return 403. Shows **estimated** creator fees (57% of 1.2% of volume). Claimable balance is only visible to the fee beneficiary via `bankr fees --token`. For Base mainnet volume, set `DOPPLER_INDEXER_URL=https://bankr.indexer.doppler.lol` and `CHAIN_ID=8453`.

**Why volume comes from the indexer:** Trading volume is aggregated from swap events; there is no single onchain view that returns “total volume” for a pool. The Doppler indexer (Ponder) indexes those events and exposes `volumeUsd` via GraphQL/REST. Contract reads (e.g. viem `readContract`) and the Doppler SDK give pool *state* (fee tier, status), not cumulative volume. Optional: install `@whetstone-research/doppler-sdk` to show pool state (fee %, Locked/Exited) in token-stats.

**Lookup by wallet / X / Farcaster:**
Find Bankr tokens where a given wallet is deployer or fee recipient, or where an X/Farcaster handle is associated:

```bash
BANKR_API_KEY=bk_xxx npm run lookup -- 0x62Bcefd446f97526ECC1375D02e014cFb8b48BA3
npm run lookup -- @vyrozas
npm run lookup -- dwr.eth
```

Searches the most recent launches (up to `BANKR_LAUNCHES_LIMIT`, default 500). The script requests up to 50 results per page from the Bankr search API and shows **total token count**; if the API returns fewer (e.g. a 5-result cap), the CLI and Discord **lookup** still show “Total: N token(s)” and link to the full list at [bankr.bot/launches/search](https://bankr.bot/launches/search?q=). Discord shows “Showing 1–25 of N” when there are more than 25; use the site for full list and pagination.

## Fees: claimable now, historical, and claimed

This project focuses on three fee views (no leaderboards, charts, or OHLC):

| What | How you see it | Source |
|------|----------------|--------|
| **Claimable right now** (token + WETH) | Discord: mention bot + token address (or paste CA); or `GET /claimable?token=<addr>` (fee-api); or `bankr fees --token <addr>`. Same **with or without** indexer. | **On-chain** only: Rehype hook `getHookFees(poolId)` via Base RPC. |
| **Historical accrued** (all-time fees for beneficiary) | Shown in Discord/CLI when the indexer is running and has `cumulatedFees` for that pool+beneficiary. | **Indexer** (Doppler indexer `cumulatedFees`). |
| **Already claimed** | When both indexer and chain data exist: **Already claimed ≈ Accrued − Claimable** (shown in Discord for that token). | Derived: indexer accrued minus on-chain claimable. |

**Requirements:** `RPC_URL` (or `RPC_URL_BASE`) for Base to read claimable. Bankr launch must have `poolId` (from Bankr API). For historical + claimed you need `DOPPLER_INDEXER_URL` and an indexer that exposes `cumulatedFees`.

**Indexer “last updated”:** The production indexer’s public GraphQL schema does not expose a block number or timestamp for “indexer data as of.” If you self-host the indexer, you can add a custom field or query that returns the latest synced block.

**Monitoring when fees are claimed:** The bot can notify when a specific token’s fees are claimed. Use **/claim-watch add** with a token address (0x…); the bot stores the last-known claimable and, on each poll, if claimable drops it posts to your server’s watch/alert channel. **/claim-watch list** and **/claim-watch remove** manage the list. Requires **/setup** (per-server config) and runs in the same poll loop as launch alerts.

## Fees: claimed vs unclaimed ETH (Bankr app)

**Whether a token’s fees have been claimed** and **how much ETH is claimable** are not exposed by the Bankr REST API. Use Bankr’s own tools:

- **In Bankr (app/bot):** e.g. *“check my fees for TokenName”*, *“show my unclaimed fees”*, *“show all my tokens with unclaimed fees”*.
- **Bankr CLI:** [Claiming Fees](https://docs.bankr.bot/token-launching/claiming-fees) describes the fee dashboard and claiming:
  ```bash
  npm install -g @bankr/cli
  bankr fees                    # fee dashboard
  bankr fees --token 0x...      # fees for one token
  bankr fees --json             # raw JSON for scripting
  bankr fees claim 0x...        # claim fees for token
  ```

Only the current fee beneficiary can claim; you receive your token + WETH from the 1.2% swap fee (creator share 57%).

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

- `BANKR_API_KEY` — **Recommended.** Bankr API key from [bankr.bot/api](https://bankr.bot/api). Bankr-only launches, no RPC needed.
- `BANKR_LAUNCHES_LIMIT` — Max launches per fetch (default 500). Passed as `?limit=` to the API.
- `FILTER_X_MATCH` — When `1` or `true`, the **main/alert feed** only notifies when deployer and fee recipient share the same X or Farcaster account (reduces spam). Watch-list matches are unchanged and still post to the watch channel.
- `FILTER_MAX_DEPLOYS` — Max deploy count for launcher; skip if they've launched more (e.g. `2` = only first or second launch).
- `WATCH_X_USERS` — Comma-separated X handles; only notify when deployer's X is in this list (e.g. `thryxagi,crewdegen`).
- `WATCH_FC_USERS` — Comma-separated Farcaster handles; only notify when deployer's Farcaster is in this list (e.g. `dwr.eth,vitalik.eth`).
- `POLL_INTERVAL_MS` — Ms between fetches (default 60000 = 1 min). Use 30000 for 30 sec to catch launches quickly.
- `RPC_URL_BASE` — Base RPC URL (for chain fallback when indexer fails; only needed if not using Bankr API)
- `DOPPLER_INDEXER_URL` — optional; defaults to https://bankr.indexer.doppler.lol for Base mainnet, testnet indexer for Sepolia

## Usage

### Fetch from Doppler Indexer

```bash
npm run fetch:indexer
```

Use `CHAIN_ID=84532` for Base Sepolia (testnet indexer) or `CHAIN_ID=8453` for Base mainnet (indexer must support it).

### Fetch from Chain (Base)

```bash
npm run fetch:chain
```

Uses `RPC_URL_BASE` or `RPC_URL`. Optionally set `BLOCKS_BACK` (default 50000 for CLI; 5000 for notify loop). **Alchemy Free tier** limits `eth_getLogs` to 10 blocks per request — the chain fallback chunks automatically (`RPC_GETLOGS_CHUNK_SIZE=10`). On 429 rate limit, it falls back to public Base RPC for that request. `RPC_GETLOGS_DELAY_MS=150` throttles chunk requests to avoid rate limits. Set `BLOCKS_BACK=500` to reduce RPC calls if needed.

### Combined (Indexer → Chain fallback)

```bash
OUTPUT_JSON=1 npm run fetch:all
```

Outputs JSON. Without `OUTPUT_JSON=1`, outputs a compact JSON array.

## Discord & Telegram Notifications

Notify on new launches via Discord bot channel (recommended) or webhook, and/or Telegram bot.

### Discord bot channel (recommended for /alert-watchlist and /lookup)

When using the Discord bot (`npm start`), you can set:

- **DISCORD_ALL_LAUNCHES_CHANNEL_ID** — every Bankr deploy (firehose, no filters).
- **DISCORD_ALERT_CHANNEL_ID** — curated only (respects **FILTER_X_MATCH**, **FILTER_MAX_DEPLOYS**).
- **DISCORD_WATCH_ALERT_CHANNEL_ID** — alert-watchlist matches only.

Right-click each channel → Copy channel ID (Developer Mode). You can use one, two, or all three (same launch is deduped per channel).

**Optional env when using /setup:** Per-server **/setup full** or **/setup channels** can set **all_launches_channel** (firehose), **alert_channel** (curated), **watch_channel** (alert-watchlist); at least one of firehose or curated is required on first **/setup full**. If no global env channels are set, alerts go to each server’s configured channels.

- **/alert-watchlist** — Wallets (paste `0x…` or X/Farcaster URL — stored as resolved wallet) and keywords; add / remove / edit / list.
- **/claim-watch** — Notified when a token’s fees are claimed: add/remove/list; **check** / **wallet** lookups.
- **/lookup** — Search Bankr token launches by wallet, X handle, or Farcaster (e.g. `/lookup ayowtfchil` or `/lookup 0x6686...`). Uses the same search as [bankr.bot/launches/search](https://bankr.bot/launches/search); full list link is included in the reply.

**Who can do what:** Only server admins (Discord **Manage Server** permission) can run **/setup** subcommands that change config, **/alert-watchlist add** / **remove**, **/claim-watch add** / **remove**, and **/deploy**. Everyone can use **/lookup**, **/wallet-lookup**, **/alert-watchlist list**, **/claim-watch list**, **/help**, and **Bankr token** paste or @mention fee replies — only when the message includes a contract ending in **…ba3** (use **/lookup** for handles and profile URLs).

**Bot permissions:** The bot must be able to **View Channel**, **Send Messages**, and **Embed Links** in both channels. If you see `Watch channel … failed: Missing Access` in logs, open the watch channel → channel settings → Permissions → add your bot with those permissions (or use “Add members” and grant the bot role access).

**Debug webhook (optional):** Set **DISCORD_DEBUG_WEBHOOK_URL** to a Discord webhook URL to receive: (1) a message on startup with how many Discord servers the bot is in and how many have /setup or Telegram configured, (2) a catch-all of user activity (e.g. `/lookup`, paste Bankr CA, mention + ba3 CA, `/deploy`, `/alert-watchlist list`, `/claim-watch list`), and (3) errors (notify failures, lookup failures, uncaught exceptions).

**Three feed types:**

| Variable | Purpose |
|----------|---------|
| **DISCORD_ALL_LAUNCHES_CHANNEL_ID** | **Firehose** — every Bankr deployment (no filter) |
| **DISCORD_ALERT_CHANNEL_ID** | **Curated** — only if deploy passes **FILTER_X_MATCH** / **FILTER_MAX_DEPLOYS** |
| **DISCORD_WATCH_ALERT_CHANNEL_ID** | **Alert watchlist** — only tokens matching **/alert-watchlist** (wallets + keywords; legacy X/FC rows still match) |

Example: one channel for all deploys, another for “quality” deploys (same X on deployer + fee recipient), a third for your watch list.

### Setup

1. **Discord webhook** (when not using DISCORD_ALERT_CHANNEL_ID or DISCORD_WATCH_ALERT_CHANNEL_ID)
   - Server → Server Settings → Integrations → Webhooks → New Webhook
   - Copy the webhook URL

2. **Telegram firehose (subscription channel)**  
   Use a **channel** (not a group) so people can subscribe and get every Bankr deployment:

   - **Create a channel:** Telegram → Menu → New Channel → name it (e.g. "Bankr Deploys") → add a description.
   - **Make it public** (optional): Channel info → Edit → set a **username** (e.g. `bankr_deploys`). Share **t.me/bankr_deploys** so anyone can join. Or leave it private and share an invite link.
   - **Add your bot:** Channel → Administrators → Add Admin → your bot → enable **Post messages** (and **Edit messages** if you want). No need for other permissions.
   - **Get the channel chat ID:** Channel IDs look like `-1001234567890`. Easiest: forward any message from the channel to [@userinfobot](https://t.me/userinfobot) or to [@RawDataBot](https://t.me/RawDataBot); the reply shows the chat ID. Or add the bot, post once, then open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` and read `message.chat.id` (use the bot token from [@BotFather](https://t.me/BotFather)).
   - Set **TELEGRAM_BOT_TOKEN** (from @BotFather) and **TELEGRAM_CHAT_ID** (the channel ID) in your env. The bot will post every new Bankr launch to that channel; subscribers see the firehose.

   The **channel** setup above is broadcast-only (the bot posts; subscribers read).

   **Optional — same bot, private DMs:** With the **Discord bot** running, set **TELEGRAM_PERSONAL_DMS_ENABLED=true** and open a **private chat** with your bot → **/start**. Users get personal alerts: **watchlist launch/claim** matches (with a non-empty watchlist), plus optional **trending** and **hot** — toggled via **`/alerts`**. (No full firehose in DMs; use the channel/group topic for that.) **Watchlist launch/claim** DMs are sent in the same processing pass as your main feeds (default **no extra delay**; optional **TELEGRAM_DM_WATCHLIST_DELAY_MS**). **Hot/trending** personal DMs follow **TELEGRAM_DM_DELAY_MS** or **TELEGRAM_HOT_PING_DELAY_MS** (e.g. 1 min after Discord). Restrict registration with **TELEGRAM_DM_ALLOWED_USER_IDS** if needed.
   **Why did my Telegram watchlist reset after deploy?** On Railway (and similar hosts), the container disk is **replaced each deploy**. Unless **`TELEGRAM_PERSONAL_USERS_FILE`** points to a **mounted volume** (e.g. **`/data/telegram-personal-users.json`**), the default file in the app folder is wiped — same as **`TENANTS_FILE`**. See **docs/RAILWAY_AND_TENANT_STORAGE.md**.

   **Share with users:** Once the channel is public, give people the link (e.g. **t.me/your_channel_username**). They join the channel and get every new Bankr deploy automatically.

3. **Telegram group with 4 topics (All launches, Hot, Trending, X only fee recipient)**  
   Use **one group** with **Topics** (forum mode), not separate channels. Each feed is a topic (thread) inside the same group. You can make the group **read-only** so only the bot (and admins) can post.

   - **Create a group:** Telegram → New Group → name it (e.g. "Bankr Alerts").
   - **Enable Topics:** Group settings → Edit → turn on **Topics** (forum style). This creates a main thread; you’ll add one topic per feed.
   - **Make it read-only (optional):** Group settings → **Permissions** → under “What can members do?”, turn off **Send messages** (and **Send media** / **Add reactions** if you want). Then only **admins** (e.g. your bot) can post; members only read. The bot must be added as an admin with “Post messages” (and “Manage topics” if the bot creates topics).
   - **Create 4 topics:** In the group, use “New Topic” and create:
     - **All launches** — firehose (every deploy)
     - **Hot launches** — delayed hot ping (e.g. 5+ buys in 1 min, 20+ holders)
     - **Trending Tokens** — same as hot (trending ping)
     - **X only fee recipient** — curated (only when fee recipient has X; set **Filter fee recipient has X** in **/setup rules**)
   - **Add your bot:** Group → Add members → your bot. Give it **Post messages** (and **Manage topics** if you want the bot to create topics; usually you create them manually).
   - **Get group ID and topic IDs:**
     - **Group ID:** Forward a message from the group to [@userinfobot](https://t.me/userinfobot) or [@RawDataBot](https://t.me/RawDataBot); the reply shows the chat ID (e.g. `-1001234567890`). Or send any message in the group, then open `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates` and read `message.chat.id`.
     - **Topic IDs:** Each topic’s thread ID is the **message_id** of the topic’s first (header) message. After creating a topic, send a message in it, then call `getUpdates` and look at `message.message_thread_id` in the reply — that’s the topic ID. Or use a bot that reports thread IDs (e.g. post in the topic and inspect updates). Topic IDs are integers (e.g. `2`, `3`, `4`, `5`).
   - **Configure:**
     - **Env (single group):** Set `TELEGRAM_CHAT_ID` to the group ID. Set `TELEGRAM_TOPIC_FIREHOSE`, `TELEGRAM_TOPIC_CURATED`, `TELEGRAM_TOPIC_HOT`, `TELEGRAM_TOPIC_TRENDING` to the four topic IDs (integers or numeric strings).
     - **Per-server (Discord bot):** In the server where the bot is in, run **/setup telegram**. Set **group_chat_id** to the Telegram group ID, then **topic_firehose**, **topic_curated** (X only fee recipient), **topic_hot**, **topic_trending** to the four topic IDs.
   - **Delay for Telegram Hot/Trending:** Hot and Trending pings are sent to Discord first; then, by default, **1 minute later** they are sent to the Telegram Hot and Trending topics. You can change this later: set **TELEGRAM_HOT_PING_DELAY_MS** in env (default `60000` ms), or per server run **/setup telegram** and set **delay_hot_trending_sec** (e.g. `60` for 1 min, `0` for same time as Discord).
   - **Restrict to your group only:** Set **TELEGRAM_ALLOWED_CHAT_IDS** to your group’s chat ID (e.g. `-1001234567890`). The bot will only send to that chat; if someone adds the bot to another group, it will not post there. Use a comma-separated list for multiple groups. Leave unset to allow all.

4. **Environment variables**
   ```bash
   BANKR_API_KEY=bk_xxx           # Recommended: Bankr-only launches
   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
   TELEGRAM_BOT_TOKEN=123456:ABC...
   TELEGRAM_CHAT_ID=-1001234567890   # Group or channel ID
   # Optional: topic IDs for group with 4 feeds (integers)
   TELEGRAM_TOPIC_FIREHOSE=2         # All launches
   TELEGRAM_TOPIC_CURATED=3          # X only fee recipient (see TELEGRAM_CURATED_FEE_RECIPIENT_HAS_X)
   TELEGRAM_CURATED_FEE_RECIPIENT_HAS_X=true   # When true, curated topic only gets launches where fee recipient has X. Does not affect Discord or FILTER_*.
   TELEGRAM_TOPIC_HOT=4              # Hot launches
   TELEGRAM_TOPIC_TRENDING=5         # Trending Tokens
   TELEGRAM_HOT_PING_DELAY_MS=60000  # Delay Telegram hot/trending vs Discord (default 1 min)
   TELEGRAM_ALLOWED_CHAT_IDS=-1001234567890  # Only these chat IDs receive messages (your group). Unset = allow all.
   ```

### Run once

```bash
npm run notify
```

### Run continuously (poll every 5 min)

```bash
npm run notify:loop
# or
npm start
```

Set `POLL_INTERVAL_MS` (default 60000 = 1 min) to change poll frequency. Use 30000 for 30 sec to catch launches as they come in; for watch-list alerts, 20000–30000 reduces the chance of missing a deploy that appears between polls. Seen tokens are stored in `.bankr-seen.json` to avoid duplicate notifications.

## Deploy on Railway

**Option A: Long-running worker (always-on)**

1. Create a new project on [Railway](https://railway.app)
2. Connect this repo
3. Add variables: `BANKR_API_KEY` (recommended), `DISCORD_BOT_TOKEN`, `DISCORD_ALERT_CHANNEL_ID` or `DISCORD_WATCH_ALERT_CHANNEL_ID` (for watch-list alerts), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `CHAIN_ID`
4. Set start command: `npm start` (or leave default — uses `npm start`)
5. Deploy; the worker runs and polls every 5 minutes

**Option B: Cron (scheduled)**

1. In Railway, add a **Cron Job** service
2. Schedule: `*/5 * * * *` (every 5 minutes)
3. Command: `npm run notify`
4. Add the same env vars

Railway containers use an **ephemeral filesystem** by default. To persist the seen list and watch list across deploys:

1. Add a **Volume** to your service (e.g. mount path `/data`).
2. Set variables:
   - `WATCH_FILE=/data/bankr-watch.json` — watch list (X, Farcaster, wallet, keywords)
   - `SEEN_FILE=/data/bankr-seen.json` — path on a **volume** so the seen list persists across deploys (stops "50 pings then 0 new" on every restart).
   - `CLAIM_STATE_FILE=/data/bankr-claim-state.json` — optional; last-known claimable per (server, token) for claim-watch alerts.
   - `SEEN_AGENTS_FILE=/data/bankr-seen-agents.json` — optional; seen agent profile IDs so new-agent pings only fire for newly added agents (otherwise every deploy can re-ping up to 50).
3. Optional: `SEEN_MAX_KEYS` — cap the seen list (e.g. `3000`) to limit file size; if unset, the list is unbounded and each token is only ever notified once.

## Output Fields

Each launch entry includes:

| Field | Description |
|-------|-------------|
| `name` | Token name |
| `symbol` | Token symbol |
| `tokenAddress` | Contract address |
| `launcher` | Launcher/creator address (when available) |
| `beneficiaries` | Fee recipients (from indexer) |
| `image` | Token image URL |
| `pool` | Pool ID or address |
| `volumeUsd` | Volume (from indexer) |
| `holderCount` | Holder count (from indexer) |
| `x` | X/Twitter handle from token metadata |
| `website` | Website URL from token metadata |

Bankr stores `x`, `website`, `tweetUrl`, etc. in the token’s on-chain metadata (tokenURI). The Doppler indexer fetches this as `tokenUriData`. The chain fetcher resolves tokenURI and parses the JSON.

## References

- [Bankr Docs](https://docs.bankr.bot)
- [Bankr Token Deploy API](https://docs.bankr.bot/token-launching/deploy-api)
- [Doppler Protocol](https://docs.doppler.lol)
- [Doppler Indexer](https://github.com/whetstoneresearch/doppler-indexer)
- [Doppler Indexer API (GraphQL, REST)](https://docs.doppler.lol/indexer/reference)
- [Doppler Contract Addresses](https://docs.doppler.lol/resources/contract-addresses)
