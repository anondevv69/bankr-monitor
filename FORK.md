# Personal fork

This repository is a **self-hosted, personal-use** fork of tooling around [Bankr](https://bankr.bot) launches on Base. It is **not** affiliated with Bankr, Inc.

## Upstream

Development was originally based on community work around the same stack (Discord/Telegram bots, indexer integration). If you publish your own GitHub remote, set **`BRAND_REPO_URL`** in the environment so HTTP `User-Agent` strings point at your repo instead of any previous fork.

## Your GitHub

1. Create a **new empty repository** on your GitHub account (no README/license if you will push this tree as `main`).
2. Point `origin` at it and push:

```bash
git remote remove origin   # only if replacing the old remote
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git branch -M main
git push -u origin main
```

3. On Railway (or your host), connect the service to **your** repo and redeploy.

## Branding

Optional environment variables (see `.env.example`):

- **`BRAND_DISPLAY_NAME`** — shown in Discord embeds and Telegram copy (default: `BankrMonitor Personal`).
- **`BRAND_REPO_URL`** — optional URL included in API `User-Agent` strings (e.g. your GitHub repo).
