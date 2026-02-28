# Multi-tenant design: one bot, many servers

Each Discord server (or Telegram group) that adds the bot gets **its own config**: API key, monitoring rules, alert channels, and watchlist. They set it up once and can edit it anytime.

---

## 1. Tenant config (per Discord guild / Telegram chat)

| Field | Description |
|-------|-------------|
| **guildId** (Discord) | Server ID. Primary key for Discord. |
| **chatId** (Telegram) | Optional; for Telegram-only or dual alerts. |
| **bankrApiKey** | Their Bankr API key (for launches, lookup, deploy). Stored per tenant. |
| **alertChannelId** | Discord channel for *all* new launch alerts. |
| **watchAlertChannelId** | Discord channel for *watch-list* matches only (optional). |
| **telegramChatId** | If they want Telegram alerts for this tenant. |
| **rules** | Monitoring rules: `filterXMatch`, `filterMaxDeploys`, `pollIntervalMs`, etc. |
| **watchlist** | X handles, Farcaster handles, wallets, keywords (or reference to per-guild watch store). |
| **optionalOverrides** | `dopplerIndexerUrl`, `rpcUrl` if they want to override defaults. |

**Storage:** File-based (e.g. `.bankr-tenants.json` keyed by `guildId`) or DB (Postgres/Supabase) for scale. API keys should be stored with care (e.g. env-style or encrypted at rest if required).

---

## 2. Setup flow (when they “start” the bot)

- **Option A – When bot joins the server:** Post a welcome message in the first channel the bot can post to: “To enable Bankr monitoring, run `/setup` and follow the steps.”
- **Option B – First use of any command:** If the guild has no config, reply with “Run `/setup` to configure your API key, rules, and watchlist.”

**`/setup`** (wizard or single modal):

1. **API key** – “Enter your Bankr API key (from bankr.bot/api).” Store in tenant config.
2. **Alert channel** – “Choose the channel for all new token alerts.” (channel picker or ID)
3. **Watch alert channel** (optional) – “Choose the channel for watch-list matches only, or skip.”
4. **Rules** – “Only alert when deployer and fee recipient match?” (filter_x_match), “Max deploys per day to alert?” (filter_max_deploys), “Poll interval (minutes).” (poll_interval_ms)
5. **Watchlist** – “Add X handles, wallets, keywords via `/watch add` after setup.”

After saving, mark tenant as configured so the notify loop includes this guild.

---

## 3. Editing config anytime

**`/settings`** (or **/config**):

- Subcommands or buttons: **API key**, **Channels**, **Rules**, **View watchlist**.
- **API key** – Update Bankr API key (modal or DM for security).
- **Channels** – Change alert channel and/or watch alert channel.
- **Rules** – Update filter_x_match, filter_max_deploys, poll_interval_ms.
- **Watchlist** – Show current list; “Use `/watch add` and `/watch remove` to edit.”

All of this reads/writes the **tenant config** for the current guild (and optionally Telegram chat).

---

## 4. Watchlist per server

- **Current:** One global watch list (file + env) used by everyone.
- **Multi-tenant:** Watch list is **per guild**.
  - Either store `watchlist: { x, fc, wallet, keywords }` inside tenant config and update it when they use `/watch add` or `/watch remove`, or
  - Keep a per-guild watch file (e.g. `.bankr-watch-<guildId>.json`) and have `watch-store.js` accept `guildId` so `getWatchList(guildId)`, `addWallet(addr, guildId)`, etc.

Commands **`/watch add`**, **`/watch remove`**, **`/watch list`** use the **current guild’s** watchlist (and tenant config).

---

## 5. Notify loop (per-tenant)

- **Current:** One global poll; uses `BANKR_API_KEY`, `DISCORD_ALERT_CHANNEL_ID`, `DISCORD_WATCH_ALERT_CHANNEL_ID`, global watch list, global filters.
- **Multi-tenant (target):**
  - Load **all tenant configs** that have at least one alert channel (Discord or Telegram).
  - For **each tenant:** Run the equivalent of `runNotifyCycle()` with that tenant’s `bankrApiKey`, channels, rules, and watchlist; post new launches to that tenant’s Discord channel(s) and/or Telegram.

**Implementation note:** The notify loop in `notify.js` still uses global env and `getWatchList()` (no tenant argument). To complete multi-tenant alerting, `runNotifyCycle(options)` needs to accept an options object (e.g. `{ bankrApiKey, alertChannelId, watchAlertChannelId, rules, watchlist }`) and the Discord bot’s `runNotify()` should iterate over `listActiveTenantGuildIds()`, load each tenant, call `runNotifyCycle(tenantOptions)`, and send embeds to that tenant’s channels. Until that refactor, servers that use **/setup** have their config and per-server watchlist stored; alerting still uses global env and global watch list when channels are set via env.

---

## 6. Telegram

- Each “tenant” can be a Discord guild, a Telegram chat, or both (same config or linked).
- Store `telegramChatId` in tenant config; when sending alerts, send to both Discord channels and Telegram if configured.
- For “Telegram-only” tenants (no Discord), you need a way to register a chat (e.g. “Send /start in the group and the bot will register this chat”). Then the notify loop includes Telegram-only tenants and sends only to Telegram.

---

## 7. Summary

| Piece | Change |
|-------|--------|
| **Config** | Per-guild (and optionally per–Telegram-chat) tenant config: API key, channels, rules, watchlist. |
| **Setup** | `/setup` to collect API key, channels, rules; then they use `/watch` for watchlist. |
| **Edit** | `/settings` to update API key, channels, rules anytime. |
| **Watchlist** | Per-guild (or inside tenant config); `/watch` scoped to current guild. |
| **Notify** | One loop; for each tenant run notify with tenant’s config and post to that tenant’s channels. |

This gives you one bot that many people can add to their own Discord (and optionally Telegram), each with their own API key, rules, and watchlist, and they can always edit everything via `/setup` and `/settings`.
