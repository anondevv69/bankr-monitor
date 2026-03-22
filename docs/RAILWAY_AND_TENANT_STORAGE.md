# Railway setup + where per-server settings live

## 1. One Railway project, three services

You can run **everything in one Railway project**: Postgres, the Doppler indexer, and the BankrMonitor Discord bot.

| Service        | What it is        | Deploy from                          |
|----------------|-------------------|--------------------------------------|
| **PostgreSQL** | Database          | Railway → Add Service → **Database** → PostgreSQL |
| **Indexer**    | Doppler indexer   | Railway → Add Service → **GitHub Repo** → your doppler-indexer (fork) |
| **Bot**        | BankrMonitor      | Railway → Add Service → **GitHub Repo** → your bankr-monitor repo |

You do **not** need a second Railway project. One project, three services.

---

## 2. Do you need to fork the indexer?

**Yes, in practice.** The [doppler-indexer](https://github.com/whetstoneresearch/doppler-indexer) default config often hardcodes a local Postgres URL. To use Railway’s Postgres you need the indexer to use `DATABASE_URL` from the environment.

1. **Fork** [whetstoneresearch/doppler-indexer](https://github.com/whetstoneresearch/doppler-indexer) to your GitHub.
2. In your fork, make the database config env-driven (e.g. in `ponder.config.multicurve.ts`):

   ```ts
   database: {
     kind: "postgres",
     connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/default",
     poolConfig: { max: 100 },
   },
   ```

3. In Railway, add a new service and connect it to **your fork** (not the upstream repo).
4. In the **indexer** service variables, set `DATABASE_URL` to a **reference** to the Postgres service’s `DATABASE_URL` (Railway → Variables → New Variable → Add Reference → choose Postgres → `DATABASE_URL`).
5. Set `PONDER_RPC_URL_8453` (Base) and `PONDER_RPC_URL_1` (ETH mainnet for price), then set the start command and generate a domain as in the main README.

So: **same Railway project**, but the indexer service should deploy from **your fork** so you can use Railway’s Postgres.

---

## 3. Where are each server’s settings stored?

Per-server config (from **/setup** and **/settings**) is stored in a **single JSON file** on the machine where the bot runs.

| Env (optional)   | Default                    | Purpose |
|------------------|----------------------------|---------|
| `TENANTS_FILE`   | `.bankr-tenants.json` (in app root) | Path to the file that holds every server’s config (API key, channels, rules, watchlist). |

So **all** servers that use your bot are “housed” in that one file: one object keyed by Discord guild ID, each value is that server’s settings.

**On Railway (ephemeral disk):** By default the filesystem is reset on deploy, so that file would be lost on every redeploy. To keep it:

- **Option A – Persistent volume**  
  1. In the **BankrMonitor (bot)** service, go to **Settings** → **Volumes** → **Add Volume**, e.g. mount path `/data`.  
  2. Set in **Variables**:  
     `TENANTS_FILE=/data/bankr-tenants.json`  
  So the file lives on the volume and survives redeploys. Optionally also set `SEEN_FILE=/data/bankr-seen.json` and `WATCH_FILE=/data/bankr-watch.json` if you use the global watch/seen lists.

- **Option B – Database later**  
  You could later change the code to store tenant config in Postgres (or another DB) instead of a file. Then you wouldn’t need a volume for tenant data; the same Railway Postgres could have a `tenants` table, or you could use a separate DB. Right now the code only supports the file.

**Summary:** Today, per-server settings are in one JSON file. Point that file to a **persistent volume** on Railway (e.g. `TENANTS_FILE=/data/bankr-tenants.json`) so they survive redeploys.

### Telegram personal DMs (private `/start` watchlists)

If **`TELEGRAM_PERSONAL_DMS_ENABLED=true`**, user watchlists and alert toggles are stored in **`TELEGRAM_PERSONAL_USERS_FILE`**, defaulting to **`.telegram-personal-users.json` in the app directory** — same problem: **that file is deleted on every Railway redeploy** unless it lives on a volume.

- Mount a volume (e.g. **`/data`**) on the bot service.
- Set **`TELEGRAM_PERSONAL_USERS_FILE=/data/telegram-personal-users.json`** (alongside `TENANTS_FILE=/data/bankr-tenants.json` if you use one).

Pushing code to GitHub does not clear the file; **redeploying a new container** without a persistent path does.

---

## 4. Quick Railway layout

```
Railway project (e.g. "BankrMonitor Prod")
├── Postgres          (Database)
├── doppler-indexer   (from your fork; uses DATABASE_URL → Postgres)
└── bankr-monitor     (Discord bot)
    Variables:
    - DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID
    - DOPPLER_INDEXER_URL = https://bankr.indexer.doppler.lol (or your indexer domain)
    - RPC_URL_BASE (Base mainnet RPC — required for claimable fees in /fees-token)
    - BANKR_API_KEY (optional but recommended)
    - TENANTS_FILE=/data/bankr-tenants.json   (if you added a volume at /data)
    - TELEGRAM_PERSONAL_USERS_FILE=/data/telegram-personal-users.json   (if personal Telegram DMs enabled)
    Volumes:
    - Mount path /data (so tenant + seen/watch + Telegram personal users persist)
```

The indexer and the bot are **separate services** in the same project; they don’t run in the same process. The bot talks to the indexer over HTTP (GraphQL) using `DOPPLER_INDEXER_URL`.

---

## 5. Bot service: what to set for fees and indexer

In Railway, open your **BankrMonitor (bot)** service → **Variables**, and ensure:

| Variable | Required | Purpose |
|----------|----------|---------|
| `DISCORD_BOT_TOKEN` | Yes | From Discord Developer Portal. |
| `DISCORD_ALERT_CHANNEL_ID` or `DISCORD_WATCH_ALERT_CHANNEL_ID` | At least one | Where the bot posts launch alerts. |
| **`RPC_URL_BASE`** | **For claimable fees** | Base mainnet RPC URL (e.g. `https://mainnet.base.org` or Alchemy/QuickNode). Without this, `/fees-token` cannot show "Claimable right now" (on-chain hook data). |
| `DOPPLER_INDEXER_URL` | Optional | Defaults to `https://bankr.indexer.doppler.lol`. Override only if you use a different indexer. |
| `BANKR_API_KEY` | Optional | From bankr.bot/api. Improves /lookup and single-token launch resolution. |
| `BANKR_INTEGRATION_ADDRESS` | Optional | Only for the **notify feed** (which tokens appear in the feed). Not used for /fees-token; fee recipient fees use the launch's actual fee recipient wallet. |

**To fix "everything $0" / no claimable fees:** Add **`RPC_URL_BASE`** with a Base mainnet RPC URL (e.g. Alchemy or QuickNode), save variables, then redeploy the bot. The bot uses it to read `getHookFees(poolId)` on-chain and show what the fee recipient can claim.
