# BankrMonitor

Fetch and monitor tokens deployed via [Bankr](https://bankr.bot) on Base. Bankr uses the [Doppler](https://doppler.lol) protocol for token launches (Uniswap V4 pools).

The [bankr.bot/launches](https://bankr.bot/launches) feed shows real-time token deployments with metadata: launcher, fee recipient, contract address, name, X/website links. This project provides alternative data sources when you need to fetch launches programmatically.

## Data Sources

Fetch order: **Bankr API** (when `BANKR_API_KEY` set) → **Doppler Indexer** → **Chain** (Airlock events).

### 1. Bankr API (recommended)

`GET https://api.bankr.bot/token-launches` with `X-API-Key`. Returns Bankr-only launches (Base mainnet). No RPC, no rate limits. Get a key at [bankr.bot/api](https://bankr.bot/api).

### 2. Doppler Indexer (GraphQL)

The [Doppler Indexer](https://docs.doppler.lol/indexer/overview) indexes Doppler protocol contracts and tokens on Base.

| Endpoint | Chain |
|----------|-------|
| https://testnet-indexer.doppler.lol | Base Sepolia (testnet) |
| https://indexer.doppler.lol | Base (mainnet) — check availability |

Whetstone Research hosts a free endpoint supporting Base Sepolia for development.

**Pros:** Token metadata, launcher address (`creatorAddress`), volume, holder count  
**Cons:** Production Base endpoint may be unreliable; no Bankr-specific launcher X handles (those come from Bankr’s own mapping)

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

**REST** — search tokens by name, symbol, or address:

```bash
# Search by name/symbol on Base
curl "https://testnet-indexer.doppler.lol/search/doppler?chain_ids=8453"
# Search by address
curl "https://testnet-indexer.doppler.lol/search/0x123...abc?chain_ids=8453,57073"
```

**Direct SQL (self-hosted indexer only)** — `pnpm db shell` for psql; use the connection string from `.env.local`.

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

**Check that the indexer is working:**

```bash
npm run check:indexer
# Or with a custom URL:
DOPPLER_INDEXER_URL=https://your-app.up.railway.app npm run check:indexer
```

This hits `/ready` (health) and `/graphql` (one token query). If both show **OK**, the indexer is up. You can also open `https://your-app.up.railway.app/` in a browser (Ponder often shows a simple page) or `https://your-app.up.railway.app/ready` for a 200 response.

**Optional:** Add a `cumulatedFees` (and pools-by-base-token) API in your indexer fork so token-stats can show claimable-style fees; the BankrMonitor side already calls the shape we added earlier.

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

Uses the Bankr API (launch metadata: deployer, fee recipient) and optional Doppler indexer (trading volume). Set `BANKR_API_KEY` in `.env` so the single-token launch endpoint does not return 403. Shows **estimated** creator fees (57% of 1.2% of volume). Claimable balance is only visible to the fee beneficiary via `bankr fees --token`. For Base mainnet volume, set `DOPPLER_INDEXER_URL=https://indexer.doppler.lol` and `CHAIN_ID=8453`.

**Why volume comes from the indexer:** Trading volume is aggregated from swap events; there is no single onchain view that returns “total volume” for a pool. The Doppler indexer (Ponder) indexes those events and exposes `volumeUsd` via GraphQL/REST. Contract reads (e.g. viem `readContract`) and the Doppler SDK give pool *state* (fee tier, status), not cumulative volume. Optional: install `@whetstone-research/doppler-sdk` to show pool state (fee %, Locked/Exited) in token-stats.

**Lookup by wallet / X / Farcaster:**
Find Bankr tokens where a given wallet is deployer or fee recipient, or where an X/Farcaster handle is associated:

```bash
BANKR_API_KEY=bk_xxx npm run lookup -- 0x62Bcefd446f97526ECC1375D02e014cFb8b48BA3
npm run lookup -- @vyrozas
npm run lookup -- dwr.eth
```

Searches the most recent launches (up to `BANKR_LAUNCHES_LIMIT`, default 500). The script requests up to 50 results per page from the Bankr search API and shows **total token count**; if the API returns fewer (e.g. a 5-result cap), the CLI and Discord **lookup** still show “Total: N token(s)” and link to the full list at [bankr.bot/launches/search](https://bankr.bot/launches/search?q=). Discord shows “Showing 1–25 of N” when there are more than 25; use the site for full list and pagination.

## Fees: claimed vs unclaimed ETH

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
- `DOPPLER_INDEXER_URL` — optional; defaults to testnet indexer

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

### Discord bot channel (recommended for /watch and /lookup)

When using the Discord bot (`npm start`), set **DISCORD_ALERT_CHANNEL_ID** and **DISCORD_WATCH_ALERT_CHANNEL_ID** so alerts post to channels (not the webhook). Right-click each channel → Copy channel ID (enable Developer Mode in Discord settings).

- **/watch** — Manage the launch watch list (add/remove X, Farcaster, wallet, keyword).
- **/lookup** — Search Bankr token launches by wallet, X handle, or Farcaster (e.g. `/lookup ayowtfchil` or `/lookup 0x6686...`). Uses the same search as [bankr.bot/launches/search](https://bankr.bot/launches/search); full list link is included in the reply.

**Bot permissions:** The bot must be able to **View Channel**, **Send Messages**, and **Embed Links** in both channels. If you see `Watch channel … failed: Missing Access` in logs, open the watch channel → channel settings → Permissions → add your bot with those permissions (or use “Add members” and grant the bot role access).

**Two feeds:**

| Variable | Purpose |
|----------|---------|
| **DISCORD_ALERT_CHANNEL_ID** | **Real-time deployments** — all new Bankr tokens, always on |
| **DISCORD_WATCH_ALERT_CHANNEL_ID** | **Watch list only** — only tokens matching your wallet/X/Farcaster/keyword list, elsewhere |

Use two different channels so you get every deployment in one place and your watch-list pings in another.

### Setup

1. **Discord webhook** (when not using DISCORD_ALERT_CHANNEL_ID or DISCORD_WATCH_ALERT_CHANNEL_ID)
   - Server → Server Settings → Integrations → Webhooks → New Webhook
   - Copy the webhook URL

2. **Telegram bot**
   - Message [@BotFather](https://t.me/BotFather) → `/newbot` → get token
   - For your chat ID: message [@userinfobot](https://t.me/userinfobot) or use [getUpdates](https://api.telegram.org/bot<TOKEN>/getUpdates) after sending the bot a message

3. **Environment variables**
   ```bash
   BANKR_API_KEY=bk_xxx           # Recommended: Bankr-only launches
   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
   TELEGRAM_BOT_TOKEN=123456:ABC...
   TELEGRAM_CHAT_ID=-1001234567890
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
