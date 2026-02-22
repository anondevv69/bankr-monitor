# BankrMonitor

Fetch and monitor tokens deployed via [Bankr](https://bankr.bot) on Base. Bankr uses the [Doppler](https://doppler.lol) protocol for token launches (Uniswap V4 pools).

The [bankr.bot/launches](https://bankr.bot/launches) feed shows real-time token deployments with metadata: launcher, fee recipient, contract address, name, X/website links. This project provides alternative data sources when you need to fetch launches programmatically.

## Data Sources

### 1. Doppler Indexer (GraphQL)

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

### 2. Direct Chain Indexing

Index Doppler **Airlock** `Create` events on Base. Bankr deploys via Doppler; each token creation emits `Create(asset, ...)`. Fetches token metadata (name, symbol, tokenURI) for X/website links.

**Pros:** Direct signal from Bankr’s deployment path; works whenever RPC is available  
**Cons:** Requires RPC URL; Alchemy free tier limits `getLogs` to 10 blocks per request

The notify loop uses **incremental scanning** (persists last block in `.bankr-last-block.json`), so after the first run it only scans new blocks (~20 RPC calls per 5‑min poll instead of ~500).

### 3. Bankr API

Bankr has a [Token Deploy API](https://docs.bankr.bot/token-launching/deploy-api) for **creating** tokens, but there is **no documented public API** for listing/fetching all launches. The `activityId` in deploy responses is internal. To get a launches feed similar to bankr.bot/launches, you would need to either:

- Use the Doppler indexer + chain indexing (this project)
- Ask Bankr for API access or an undocumented endpoint

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

- `RPC_URL_BASE` — Base RPC URL (required for chain indexing)
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

Uses `RPC_URL_BASE` or `RPC_URL`. Optionally set `BLOCKS_BACK` (default 50000 for CLI; 5000 for notify loop). **Alchemy Free tier** limits `eth_getLogs` to 10 blocks per request — the chain fallback chunks automatically (`RPC_GETLOGS_CHUNK_SIZE=10`). Set `BLOCKS_BACK=500` to reduce RPC calls if needed.

### Combined (Indexer → Chain fallback)

```bash
OUTPUT_JSON=1 npm run fetch:all
```

Outputs JSON. Without `OUTPUT_JSON=1`, outputs a compact JSON array.

## Discord & Telegram Notifications

Notify on new launches via Discord webhook and/or Telegram bot.

### Setup

1. **Discord webhook**
   - Server → Server Settings → Integrations → Webhooks → New Webhook
   - Copy the webhook URL

2. **Telegram bot**
   - Message [@BotFather](https://t.me/BotFather) → `/newbot` → get token
   - For your chat ID: message [@userinfobot](https://t.me/userinfobot) or use [getUpdates](https://api.telegram.org/bot<TOKEN>/getUpdates) after sending the bot a message

3. **Environment variables**
   ```bash
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

Set `POLL_INTERVAL_MS` (default 300000 = 5 min) to change poll frequency. Seen tokens are stored in `.bankr-seen.json` to avoid duplicate notifications.

## Deploy on Railway

**Option A: Long-running worker (always-on)**

1. Create a new project on [Railway](https://railway.app)
2. Connect this repo
3. Add variables: `DISCORD_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `CHAIN_ID`
4. Set start command: `npm start` (or leave default — uses `npm start`)
5. Deploy; the worker runs and polls every 5 minutes

**Option B: Cron (scheduled)**

1. In Railway, add a **Cron Job** service
2. Schedule: `*/5 * * * *` (every 5 minutes)
3. Command: `npm run notify`
4. Add the same env vars

Railway provides persistent storage by default, so `.bankr-seen.json` persists across restarts.

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
