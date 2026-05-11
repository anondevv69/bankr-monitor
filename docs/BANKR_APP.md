# Bankr Apps Control Panel

This repo includes a first-pass Bankr App frontend in `bankr-app/`.

The app is a control panel. Railway still runs the real-time monitor and sends
alerts. The Bankr App backend scripts call Railway over HTTP.

## Railway setup

Set these variables:

```bash
PORT=8000
BANKR_APP_API_TOKEN=replace_with_a_long_random_secret
BANKR_APP_USERS_FILE=/data/.bankr-app-users.json
BANKR_APP_ALERTS_ENABLED=true
```

Keep your existing variables too, especially:

```bash
BANKR_API_KEY=your_bankr_club_key
DISCORD_BOT_TOKEN=your_discord_bot_token
```

The Procfile runs the bot as a `web` process so Railway exposes the same Node
process publicly. If Railway public networking is set to port `8000`, keep
`PORT=8000` in the service variables. After deploy, test:

```bash
curl https://YOUR-RAILWAY-DOMAIN/health
```

Expected:

```json
{ "ok": true, "service": "bankr-monitor", "appApi": true }
```

## Bankr App secrets

In the Bankr App, add these secrets:

```bash
BANKR_MONITOR_API_URL=https://YOUR-RAILWAY-DOMAIN
BANKR_MONITOR_API_TOKEN=the_same_value_as_BANKR_APP_API_TOKEN
```

The app manifest needs:

```json
["read:wallet", "fetch:http", "read:secrets"]
```

## Files to copy into Bankr Apps

Copy these into the app you started at `bankr-monitor-app-v1`:

```text
bankr-app/manifest.json
bankr-app/index.html
bankr-app/scripts/loadConfig.ts
bankr-app/scripts/saveConfig.ts
bankr-app/scripts/testDestination.ts
bankr-app/scripts/walletLookup.ts
```

## What works in this first pass

- Save per-Bankr-wallet monitor config.
- Paste a Discord webhook URL instead of inviting the Discord bot to a server.
- Manage watched X handles, wallets, token addresses, and keywords.
- Enable watchlist match alerts, trending alerts, and hot alerts per webhook.
- Run wallet lookup from the app.
- Send a test ping to the Discord webhook.

Claim alerts are intentionally hidden in the web panel until the app-user
claim-routing flow is wired.

## Telegram status

The UI stores `telegramChatId`, but Telegram delivery from the app is not wired
yet. Telegram needs a pairing flow through the Telegram bot because Telegram
does not work like Discord incoming webhooks.

The next pass should add:

- `/connect_bankr_app <code>` in Telegram.
- A Railway endpoint to create/confirm pairing codes.
- Telegram destination fanout for app users.

