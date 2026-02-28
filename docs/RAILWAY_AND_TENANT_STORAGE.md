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

---

## 4. Quick Railway layout

```
Railway project (e.g. "BankrMonitor Prod")
├── Postgres          (Database)
├── doppler-indexer   (from your fork; uses DATABASE_URL → Postgres)
└── bankr-monitor     (Discord bot)
    Variables:
    - DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID
    - DOPPLER_INDEXER_URL = https://<indexer-service>.up.railway.app  (indexer’s generated domain)
    - RPC_URL (Base)
    - BANKR_API_KEY (optional but recommended)
    - TENANTS_FILE=/data/bankr-tenants.json   (if you added a volume at /data)
    Volumes:
    - Mount path /data (so tenant + seen/watch files persist)
```

The indexer and the bot are **separate services** in the same project; they don’t run in the same process. The bot talks to the indexer over HTTP (GraphQL) using `DOPPLER_INDEXER_URL`.
