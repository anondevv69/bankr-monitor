# Lookup & APIs: What BankrMonitor Uses

This doc describes **what we use to fetch launch/lookup data** so you can verify behavior (e.g. with ChatGPT or against Bankr’s docs).

## Wallet / handle lookup (e.g. `0x7878...` or `@sodofi_`)

**Goal:** Find all Bankr tokens where a given wallet is **deployer** or **fee recipient**, or resolve an X/Farcaster handle to a wallet and then search by that wallet.

### 1. Search API (primary for wallet query)

- **Endpoint:** `GET https://api.bankr.bot/token-launches/search`
- **Query params:** `q=<wallet|handle>`, `limit` (default 25), `offset`
- **Headers:** `Accept: application/json`, `User-Agent: BankrMonitor/1.0 (...)`, and optionally `X-API-Key: <BANKR_API_KEY>` (from env or /setup).
- **Response shape we handle:**
  - **`exactMatch`** – When the query matches a **single** launch (e.g. one token where this wallet is fee recipient), Bankr returns that launch in `exactMatch`, not in `groups`. We **must** read `exactMatch` and treat it as one result (see `getSearchResultArrays` in `src/lookup-deployer.js`). Example: `?q=0x7878724b28afcfd452ea22d14b89493af38a7d41` → one launch (McClaw) in `exactMatch`.
  - **`groups.byDeployer.results`**, **`groups.byFeeRecipient.results`**, **`groups.byWallet.results`** – Paginated lists when there are multiple matches.
- **Code:** `fetchSearch()` in `src/lookup-deployer.js`; parsing in `getSearchResultArrays()`.

### 2. List API (fallback when API key is set)

- **Endpoint:** `GET https://api.bankr.bot/token-launches?limit=50&offset=<offset>`
- **Headers:** `X-API-Key` (required), `Accept: application/json`, `User-Agent: ...`
- **Used when:** We have `BANKR_API_KEY` (or server’s key from /setup). We fetch pages and filter client-side by deployer/fee wallet (and for X/FC we first resolve handle → wallet from this list or via deploy simulate).
- **Code:** `fetchLaunchesPage()`, `fetchAllLaunches()` in `src/lookup-deployer.js`.

### 3. Deploy API (resolve X/FC → wallet)

- **Endpoint:** `POST https://api.bankr.bot/token-launches/deploy`
- **Body:** `{ tokenName: "ResolveCheck", simulateOnly: true, feeRecipient: { type: "x"|"farcaster"|"ens", value: "<handle>" } }`
- **Headers:** `X-API-Key` (required), `Content-Type: application/json`
- **Used when:** Resolving an X or Farcaster handle to a wallet; we read `feeDistribution.creator.address` (or similar) from the response.
- **Code:** `resolveHandleViaDeploySimulate()` in `src/lookup-deployer.js`.

### 4. Search inference + wallet retry (handle → wallet)

- **When:** `/wallet-lookup`, Telegram `/walletlookup`, and `/lookup` use `resolveHandleToWallet()`. After deploy simulate and newest (and optional oldest) launch scans, we call **`token-launches/search`** with the handle and `@handle`, then infer a single wallet from rows where that X/Farcaster is deployer or fee recipient (same idea as `bankr.bot/search`). **Code:** `inferWalletFromRawLaunches()` in `src/lookup-deployer.js`.
- **List cache:** Cached launch lists are keyed by **API key fingerprint** + limit + order so Discord and Telegram (different keys) never reuse each other’s list.
- **Empty handle lookup:** If merged results are empty but search can still infer exactly one wallet, we **run one more lookup pass by that wallet** (same merge as typing `0x…`).
- **Sparse search rows:** Inference uses **`launchWallet()`** (top-level `deployerWallet` / `feeRecipientWallet`) and flat **`deployerX` / `feeRecipientX`** fields, not only nested `deployer` objects — matching what [bankr.bot/search](https://bankr.bot/launches/search) shows. Handle resolution tries **`handle`**, **`@handle`**, and **`https://x.com/handle`** (and twitter.com) as search `q` values.

---

## If “No Bankr tokens found” but the website shows a result

- The **website** (e.g. [bankr.bot/launches/search?q=0x7878...](https://bankr.bot/launches/search?q=0x7878724b28afcfd452ea22d14b89493af38a7d41)) uses the same **search** endpoint. If the browser shows one launch (e.g. McClaw) and the bot says “No Bankr tokens found”, then either:
  1. **Bot is on an old build** – Ensure the deploy includes the commit that parses **`exactMatch`** (see `getSearchResultArrays`).
  2. **Search request from the bot fails** – From Railway the request might get 403, timeout, or empty body. Check deploy logs for `[Agent profiles]`-style or any fetch errors; we send `User-Agent` so the server can allow the client.
  3. **API key** – For **list**-based fallback and for X/FC resolution we need an API key in /setup or `BANKR_API_KEY`. For a **plain wallet** search, the **search** endpoint can return `exactMatch` without a key; if that request fails from your host, the key won’t help for that single request.

---

## Single launch page (e.g. McClaw)

- **Website:** [bankr.bot/launches/0xa1530f0d110d15425546db73a6ebc55bac821ba3](https://bankr.bot/launches/0xa1530f0d110d15425546db73a6ebc55bac821ba3)
- We don’t fetch “one launch by token address” for lookup; we get that token when it appears in **search** (e.g. `exactMatch`) or in the **list** when filtering by wallet. For **fees** for one token we use the token-launches launch endpoint (see `token-stats.js` / fee flow).

---

## Summary for ChatGPT / verification

- **Wallet lookup:** `GET https://api.bankr.bot/token-launches/search?q=WALLET&limit=25&offset=0` with `Accept` + `User-Agent`. Response may contain **`exactMatch`** (one launch) and/or **`groups.byDeployer` / `byFeeRecipient` / `byWallet`**. We **must** include `exactMatch` in the parsed results so a single-match wallet (e.g. fee recipient) shows up.
- **List (with API key):** `GET https://api.bankr.bot/token-launches?limit=50&offset=N` with `X-API-Key` + `Accept` + `User-Agent`.
- **Resolve handle:** `POST https://api.bankr.bot/token-launches/deploy` with `simulateOnly: true` and `feeRecipient: { type, value }`; read creator address from response.
