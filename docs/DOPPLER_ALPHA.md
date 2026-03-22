# Doppler indexer — alpha signals (notes)

## What the bot uses today

- **Token paste embeds:** `fetchIndexerTradingSnapshot()` calls the same path as `token-trend-card.js` (GraphQL + optional swap aggregates) so **volume**, **1h volume**, **24h buy/sell tx counts**, **trend score**, and the 📊 / 📈 / 👥 blocks come from [bankr.indexer.doppler.lol](https://bankr.indexer.doppler.lol/) when data exists. Aggregate bucket `volumeUsd` (24h + 15m) is interpreted as **18-decimal fixed USD** (same as pool mcap/liquidity); swap rows still use **12-decimal** `swapValueUsd`.
- **Hot / trending:** DexScreener buy counts + indexer **holder count** remain the defaults. Optionally set `HOT_LAUNCH_MIN_INDEXER_VOL_1H_USD` / `TRENDING_MIN_INDEXER_VOL_24H_USD` in `.env` to also fire on **indexer bucket volume** (cheap single GraphQL, no swap fan-out).

## Large buys (e.g. ≥ 1 ETH) — not wired yet

To surface “whale” buys **before** they show up everywhere you’d typically:

1. **Poll indexer `swaps`** with `swapValueUsd` / amount filters and `timestamp > lastSeen`, or  
2. **Subscribe to pool `Swap` logs** over WebSocket (Alchemy, etc.) and decode amounts.

That needs a dedicated watcher, channel/env config, and rate limits. The trend-card path already proves the indexer can return swap rows for a pool; a future job can reuse that query with a higher-frequency loop and thresholds.
