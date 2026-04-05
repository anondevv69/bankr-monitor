# Security

## Secrets (never commit)

Do **not** commit real values for:

- **`DISCORD_BOT_TOKEN`** — Discord bot token ([Developer Portal](https://discord.com/developers/applications))
- **`TELEGRAM_BOT_TOKEN`** — from [@BotFather](https://t.me/BotFather)
- **`BANKR_API_KEY`** / **`TELEGRAM_BANKR_API_KEYS`** — [bankr.bot/api](https://bankr.bot/api)
- **`BASESCAN_API_KEY`**, **`DISCORD_WEBHOOK_URL`**, **`DISCORD_DEBUG_WEBHOOK_URL`**, **`ALCHEMY_KEY`**, or any other third-party API keys

The repo includes **`.env.example`** with **placeholders only**. Copy to **`.env`** locally (`.env` is gitignored) and set secrets in your host’s **environment variables** or **secrets manager** (e.g. Railway Variables, GitHub Actions Secrets).

## Public endpoints (OK to document)

Documented URLs such as `https://api.bankr.bot`, `https://bankr.indexer.doppler.lol/graphql`, and `https://api.telegram.org/bot<TOKEN>/...` are **public** APIs. Replace **`<TOKEN>`** with your own bot token at runtime — **never** paste a live token into the repo, issues, or screenshots.

## If a secret was exposed

1. **Revoke / rotate** the token at the source (Discord, BotFather, Bankr, etc.).
2. Remove the secret from git history if it was committed ([GitHub docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)).
3. Prefer **new** credentials after rotation.

## Reporting

Open an issue for security-sensitive bugs; do not post exploit details publicly until addressed if you believe impact is severe.
