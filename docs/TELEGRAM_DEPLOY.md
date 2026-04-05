# Deploy BankrMonitor with Telegram

This guide is for self-hosters who want **Telegram** (channel/group alerts, DMs, group commands) alongside or instead of heavy Discord usage.

## Security first

- Treat **`TELEGRAM_BOT_TOKEN`** and **`BANKR_API_KEY`** like passwords. Store them only in **environment variables** or your host’s **secrets** — never in git. See [SECURITY.md](../SECURITY.md).

## How Telegram is wired in this repo

- Telegram sending and **long-polling** (commands, paste lookups, DMs) run **inside the same Node process** as the Discord bot: **`npm start`** → [`src/discord-bot.js`](../src/discord-bot.js).
- The standalone **`npm run notify`** worker posts launches to Telegram if configured, but it does **not** handle interactive Telegram commands — you need the **full bot process** for `/lookup`, `/token`, pasted addresses, etc.

## You still need a Discord bot token

The process **requires** **`DISCORD_BOT_TOKEN`** to start (`client.login`). You must create a **Discord application** and bot user ([Discord Developer Portal](https://discord.com/developers/applications)) even if you only use Telegram for users.

- **Minimal Discord usage:** Create the app, copy the bot token into env, and you can **omit** inviting the bot to any server if you only care about Telegram outbound + Telegram chat commands — the token must still be valid.

## 1. Create a Telegram bot

1. Open [@BotFather](https://t.me/BotFather) → **`/newbot`** → follow prompts.
2. Copy the **HTTP API token** → set **`TELEGRAM_BOT_TOKEN`** in your environment (never commit it).

Optional: **`/setdescription`**, **`/setcommands`** for a nicer UX.

## 2. Choose a Telegram destination

| Goal | What to configure |
|------|-------------------|
| **Broadcast channel** (firehose of launches) | Create a **channel**, add the bot as **admin** (post messages), get **`TELEGRAM_CHAT_ID`** (usually `-100…`). |
| **Forum group** (topics: firehose, hot, trending, curated) | Create a **group**, enable **Topics**, create topic threads, set **`TELEGRAM_CHAT_ID`** + **`TELEGRAM_TOPIC_*`** — see [README](../README.md#setup) § Telegram. |
| **Personal DMs** (watchlist, `/alerts`) | Set **`TELEGRAM_PERSONAL_DMS_ENABLED=true`**, users send **`/start`** in private chat. Persist users with **`TELEGRAM_PERSONAL_USERS_FILE`** on a **volume** (Railway/VPS). |

**Chat IDs:** Forward a message to [@userinfobot](https://t.me/userinfobot) or use `getUpdates` **without pasting your token into public chats** — use env locally only.

## 3. Environment variables (minimal)

```bash
# Required for process startup
DISCORD_BOT_TOKEN=<from Discord Developer Portal>
DISCORD_CLIENT_ID=<application id, for slash command registration>

# Telegram
TELEGRAM_BOT_TOKEN=<from BotFather>
TELEGRAM_CHAT_ID=-1001234567890

# Recommended for lookups / token cards / cashtags
BANKR_API_KEY=<from bankr.bot/api>
# Optional: extra keys for Telegram round-robin
# TELEGRAM_BANKR_API_KEYS=key1,key2

# Optional: restrict *outbound* notify posts to specific chats
# TELEGRAM_ALLOWED_CHAT_IDS=-1001234567890
```

See [`.env.example`](../.env.example) for the full list (indexer URL, RPC, delays, etc.).

## 4. Run locally

```bash
git clone <your-fork-or-this-repo>
cd BankrMonitor
cp .env.example .env
# Edit .env — do not commit .env

npm install
npm start
```

Confirm logs show slash commands registered and no Telegram `401` errors.

## 5. Deploy on a host (e.g. Railway)

1. **New project** → deploy from GitHub → select this repo.
2. **Variables:** paste the same env vars as above (use the **Variables** UI, not the repo).
3. **Start command:** `npm start` (default).
4. **Persistent disk (recommended):** Add a volume (e.g. mount **`/data`**) and set:
   - **`TENANTS_FILE=/data/bankr-tenants.json`** (if using Discord `/setup`)
   - **`TELEGRAM_PERSONAL_USERS_FILE=/data/telegram-personal-users.json`** (if personal DMs)
   - **`SEEN_FILE=/data/bankr-seen.json`** (launch deduplication)

See [RAILWAY_AND_TENANT_STORAGE.md](RAILWAY_AND_TENANT_STORAGE.md).

## 6. Telegram troubleshooting

| Problem | What to try |
|--------|-------------|
| Bot never replies in **groups** | [@BotFather](https://t.me/BotFather) → **`/setprivacy`** → **Disable** for your bot so it can read messages. |
| Commands work in DM but not group | Same as above; ensure the bot is in the group. |
| **`409 Conflict`** / webhook errors | Long-poll requires **no webhook**. Call Telegram’s **`deleteWebhook`** for your bot (see Telegram Bot API docs; use your token only in a private shell, never commit). |
| Outbound posts missing | Set **`TELEGRAM_BOT_TOKEN`** + **`TELEGRAM_CHAT_ID`**; check **`TELEGRAM_ALLOWED_CHAT_IDS`** isn’t blocking the destination. |

## 7. What does *not* run on Telegram alone

- **`notify:loop`** / **`notify`** alone: good for **pushing** alerts to a channel, not for **interactive** Telegram commands.
- **Discord slash commands** only register on Discord; Telegram uses **text commands** (`/lookup`, `/token`, etc.) via long-poll.

For the full feature matrix, see [CAPABILITIES.md](../CAPABILITIES.md).
