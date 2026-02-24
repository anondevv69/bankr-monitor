# BankrMonitor – Capabilities Overview

## 1. **Discord bot** (`npm start` / `npm run bot`)

| Command | What it does |
|--------|----------------|
| **/watch add** | Add a user to the launch watch list by **X (Twitter)**, **Farcaster**, **wallet**, or **keyword**. New Bankr launches matching that user are posted to the watch channel. |
| **/watch remove** | Remove a user from the watch list (by type + value). |
| **/watch list** | Show the current watch list (X, FC, wallets, keywords). |
| **/lookup** | Search Bankr tokens by **deployer** or **fee recipient**. Query can be a **wallet** (0x…), **X handle** (@user or x.com link), or **Farcaster** (handle or warpcast link). Option **by**: Deployer / Fee recipient / Both. Returns token list (latest 5 we can show + link to full list on Bankr), with pagination when we have more than 5. |
| **/fees** | Show **accrued fees (claimable-style)** for a wallet or X/Farcaster **as fee recipient**. Uses the **Doppler indexer** (`DOPPLER_INDEXER_URL` → your [doppler-indexer](https://github.com/whetstoneresearch/doppler-indexer) or a public endpoint) for `cumulatedFees`. |
| **/help** | Show this breakdown of how to use the bot. |

**Two notification channels (optional):**

- **DISCORD_ALERT_CHANNEL_ID** – All new Bankr launches (real-time feed).
- **DISCORD_WATCH_ALERT_CHANNEL_ID** – Only launches that match your watch list.

---

## 2. **Launch notifications** (Discord + Telegram)

- **Polling:** Fetches new Bankr launches on an interval (**POLL_INTERVAL_MS**; default 1 min). Uses Bankr API when **BANKR_API_KEY** is set; otherwise Doppler indexer + chain fallback.
- **Filters (env):** **FILTER_X_MATCH** (only notify when deployer and fee recipient share same X/FC), **FILTER_MAX_DEPLOYS** (max deploy count), **WATCH_X_USERS**, **WATCH_FC_USERS**, **WATCH_WALLETS**, **WATCH_KEYWORDS** for server-side watch list.
- **Telegram:** Optional **TELEGRAM_BOT_TOKEN** + **TELEGRAM_CHAT_ID** to send the same alerts to Telegram.

---

## 3. **Lookup (CLI + Discord)**

- **CLI:** `npm run lookup -- <wallet|@handle|fc_handle>`  
  Resolves wallet, X, or Farcaster (including profile URLs). Shows tokens where that identity is deployer or fee recipient; total count and link to [bankr.bot/launches/search](https://bankr.bot/launches/search).
- **Discord:** Same via **/lookup** with optional **by** (deployer / fee recipient / both). Search uses normalized handle (e.g. `ayowtfchil` from `https://x.com/ayowtfchil`).

---

## 4. **Token stats** (CLI only)

- **Command:** `npm run token-stats -- <tokenAddress>`
- **Uses:** Bankr API (launch metadata: deployer, fee recipient) + optional Doppler indexer.
- **Shows:**
  - Token name, symbol, CA, Bankr link.
  - Deployer and fee recipient (wallet + X).
  - Pool ID, tweet URL.
  - **Pool state** (Doppler SDK, optional): status (Uninitialized / Initialized / Locked / Exited), fee %.
  - **Cumulated fees (indexer):** When the indexer supports `cumulatedFees(poolId, chainId, beneficiary)` – token0, token1, and **total (USD)** for the fee recipient.
  - **Trading volume** (indexer) and **estimated creator fees** (57% of 1.2% of volume).
- **Note:** Claiming is done via Bankr app or `bankr fees claim <token>`; this script only **reports** accrued/claimable-style data when the indexer exposes it.

---

## 5. **Fees: how much is left to claim / if fees have been claimed**

- **Bankr API:** Does **not** expose “claimed” vs “unclaimed” or claimable balance.
- **Doppler indexer:** When your indexer supports **cumulatedFees** (pool + beneficiary), we can show **accrued fees** (token0, token1, total USD) per token. That is the amount that has accrued to the fee recipient; it is typically what is “claimable” until claimed (indexer usually does not track “already claimed” separately).
- **This repo:**
  - **token-stats** – Shows cumulated fees **per token** for that token’s fee recipient.
  - **/fees (Discord)** – Aggregates **across all tokens** where the queried wallet (or X/FC) is fee recipient: total USD + per-token breakdown when indexer data is available.
- **Official claiming:** Use [Bankr’s fee dashboard and CLI](https://docs.bankr.bot/token-launching/claiming-fees): `bankr fees`, `bankr fees --token 0x...`, `bankr fees claim 0x...`. Only the fee beneficiary can claim.

---

## 6. **Data sources and scripts**

| Script / Env | Purpose |
|--------------|--------|
| **fetch:indexer** | Fetch launches from Doppler indexer (GraphQL). |
| **fetch:chain** | Fetch from Base chain (Airlock events). |
| **fetch:all** | Indexer first, then chain fallback; optional JSON output. |
| **check:indexer** | Health check for **DOPPLER_INDEXER_URL** (ready + GraphQL). |
| **BANKR_API_KEY** | Bankr API (recommended): list/search launches, single-token launch, full-list merge for lookup. |
| **DOPPLER_INDEXER_URL** | [Doppler indexer](https://github.com/whetstoneresearch/doppler-indexer) URL for volume, pool data, and **cumulatedFees** (when the indexer schema supports it). |
| **BANKR_LAUNCHES_LIMIT** | Max launches scanned for full-list merge (default 50k). |

---

## Summary

- **Watch list + alerts** (Discord/Telegram), **lookup by wallet/X/FC** (CLI + Discord), **token stats** (volume + fees per token), and **aggregated fees for a wallet** via **/fees** when the indexer supports cumulatedFees.
- **Claiming** and definitive “already claimed” state stay in Bankr’s app/CLI; we surface **accrued/claimable-style** totals from the indexer where available.
