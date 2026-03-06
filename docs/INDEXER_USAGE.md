# How BankrMonitor Uses the Doppler Indexer

BankrMonitor **does not run** the indexer. It calls the **Doppler indexer’s GraphQL API** (and optional REST search) over HTTP. The indexer is a separate service (e.g. [doppler-indexer](https://github.com/whetstoneresearch/doppler-indexer) or the Bankr-hosted `https://bankr.indexer.doppler.lol`).

## Config

- **`DOPPLER_INDEXER_URL`** — Base URL of the indexer (no trailing slash). Default for Base mainnet: `https://bankr.indexer.doppler.lol`.
- **`CHAIN_ID`** — 8453 for Base, 84532 for Base Sepolia.

## When Does Data Appear in the Indexer?

- **Token/pool** — After the indexer has seen the pool’s create/migrate event on-chain (usually within a few minutes of deploy).
- **Volume / historical fees** — As swap (and mint/burn) events are indexed; typically within a few minutes of the first swap.
- **Claimable fees** — Come from **on-chain** (`getHookFees`), not the indexer. The indexer is used for **historical accrued** and **volume**; RPC is used for claimable. Set **RPC_URL_BASE** or **RPC_URL** (e.g. on Railway) so the bot can read claimable. Claimable also needs a **pool ID** (from Bankr API or indexer); if the token is very new or the indexer hasn’t indexed the pool yet, claimable can show as unavailable even when RPC is set.

So “No fee data yet” often means: pool very new or no swaps yet; indexer may not have the pool or cumulated fees yet. Data is shown in **ET** (America/New_York) where we display “Data retrieved”.

---

## 1. Token volume and pool (token-stats.js)

Used by `/fees-token`, paste detection, and token embeds.

### fetchDopplerTokenVolume(tokenAddress)

Gets one token’s `volumeUsd`, `holderCount`, `pool`, etc.

- **GraphQL by id:** `token(id: $id)` with ids `"8453-0x..."`, `"0x..."`, `"base-0x..."`.
- **GraphQL list:** `tokens(where: { chainId, address }, limit: 1) { items { ... } }`.
- **REST fallback:** `GET /search/:address?chain_ids=8453`.

```javascript
// Simplified shape we expect
const query = `
  query Token($id: String!) {
    token(id: $id) {
      address name symbol volumeUsd holderCount
      pool { address }
    }
  }
`;
// Or list: tokens(where: { chainId: 8453, address: "0x..." }, limit: 1) { items { ... } }
```

### fetchPoolByBaseToken(tokenAddress)

Finds the pool for a token so we can query cumulated fees and call the on-chain hook.

- **v4pools:** `v4pools(where: { baseToken: "0x...", chainId: 8453 }, limit: 1) { items { poolId } }`.
- **v4pools relation:** `baseToken: { address: "0x..." }` if the schema uses a relation.
- **pools:** `pools(where: { baseToken, chainId })` as fallback.
- We need **poolId** (bytes32) for cumulatedFees and for on-chain `getHookFees`.

### fetchCumulatedFees(poolId, chainId, beneficiary)

Gets historical accrued fees for a beneficiary (fee recipient).

- **Query:** `cumulatedFees(poolId: $poolId, chainId: $chainId, beneficiary: $beneficiary) { token0Fees, token1Fees, totalFeesUsd }`.
- Some indexers use **Int** for `chainId`, others **Float**; we try both.
- Singular: `cumulatedFee(...)` for find-by-primary-key.
- **Pool order:** token0 = WETH, token1 = asset (token).

---

## 2. Fetch token list (fetch-from-indexer.js)

CLI script to list tokens from the indexer.

- **tokens:** `tokens(where: { chainId }, orderBy: "firstSeenAt", orderDirection: "desc", limit) { items { address, name, symbol, volumeUsd, pool, ... } }`.
- **v4pools:** `v4pools(where: { chainId }, ...) { items { poolId, baseToken, volumeUsd, beneficiaries, ... } }`.

---

## 3. Notify feed (notify.js)

The notify loop fetches **new launches** from the Bankr API first; it can also use the indexer for a token feed. When using the indexer it filters by **integration address** (`BANKR_INTEGRATION_ADDRESS`) so only Bankr tokens are shown. The actual queries follow the same patterns as above (tokens / v4pools by chain and optional filters).

---

## Summary for Code Review (e.g. ChatGPT)

- **Entrypoints:** `src/token-stats.js` (volume, pool, cumulatedFees), `src/fetch-from-indexer.js` (token list), `src/notify.js` (feed).
- **Protocol:** POST `DOPPLER_INDEXER_URL/graphql` with `{ query, variables }`; optional GET `.../search/:address?chain_ids=...`.
- **Main queries:** `token(id)`, `tokens(where, limit)`, `v4pools(where, limit)`, `pools(where)`, `cumulatedFees(poolId, chainId, beneficiary)` / `cumulatedFee(...)`.
- **Id formats:** Token id can be `chainId-address`, `address`, or `base-address` depending on indexer.
- **Timing:** Token/pool and volume/fees usually show up within minutes of deploy and first swaps; claimable is on-chain only (RPC).
