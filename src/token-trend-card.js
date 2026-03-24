/**
 * Token "trend card" — metrics + score from Doppler Bankr indexer (GraphQL).
 * Primary: https://bankr.indexer.doppler.lol (override with DOPPLER_INDEXER_URL).
 *
 * @module token-trend-card
 */

const CHAIN_ID = parseInt(process.env.CHAIN_ID || "8453", 10);
const DEFAULT_INDEXER =
  CHAIN_ID === 8453 ? "https://bankr.indexer.doppler.lol" : "https://testnet-indexer.doppler.lol";

/** BigInt USD (mcap, liquidity, etc.) */
const USD_1E18 = 1e18;
/** Swap row `swapValueUsd` uses 12-decimal USD on this indexer. */
const USD_VOL_1E12 = 1e12;

const CHAIN_NAMES = {
  8453: "Base",
  84532: "Base Sepolia",
};

export function scoreToLabel(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return "NOT_TRENDING";
  if (s >= 75) return "HOT";
  if (s >= 55) return "TRENDING";
  if (s >= 35) return "WARM";
  return "NOT_TRENDING";
}

/**
 * Safe number from BigInt-ish string; null → 0 for JSON output.
 * @param {unknown} v
 * @param {number} divisor
 */
export function numFromScaled(v, divisor) {
  if (v == null || v === "") return 0;
  try {
    const n = typeof v === "bigint" ? Number(v) : Number(String(v));
    if (!Number.isFinite(n)) return 0;
    return n / divisor;
  } catch {
    return 0;
  }
}

/**
 * @param {{
 *   change1hPct: number,
 *   change2hPct: number,
 *   change4hPct: number,
 *   vol1h: number,
 *   vol24h: number,
 *   traders24h: number,
 *   trades24h: number,
 *   buyTx24h: number,
 *   sellTx24h: number,
 * }} input
 * @returns {number} 0–100
 */
export function computeTrendScore(input) {
  const c1 = Math.abs(Number(input.change1hPct) || 0);
  const c2 = Math.abs(Number(input.change2hPct) || 0);
  const c4 = Math.abs(Number(input.change4hPct) || 0);
  const avgCh = (c1 + c2 + c4) / 3;
  const momentum = Math.min(100, avgCh * 5);

  const vol24 = Math.max(0, Number(input.vol24h) || 0);
  const vol1 = Math.max(0, Number(input.vol1h) || 0);
  const baseline = vol24 / 24;
  const volRatio = baseline > 1e-9 ? vol1 / baseline : vol1 > 0 ? 25 : 0;
  const volAccel = Math.min(100, 25 * Math.log10(1 + volRatio));

  const traders = Math.max(0, Number(input.traders24h) || 0);
  const trades = Math.max(0, Number(input.trades24h) || 0);
  const traderScore = Math.min(100, Math.sqrt(traders) * 4 + Math.sqrt(trades) * 1.2);

  const bt = Math.max(0, Number(input.buyTx24h) || 0);
  const st = Math.max(0, Number(input.sellTx24h) || 0);
  let buyPressure = 50;
  if (bt + st > 0) buyPressure = (bt / (bt + st)) * 100;

  const raw = 0.35 * momentum + 0.3 * volAccel + 0.2 * traderScore + 0.15 * buyPressure;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * @param {TrendCard} card
 * @returns {string}
 */
export function formatTrendCardText(card) {
  const sym = card.token || "Token";
  const pct = (n) => (Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(2)}%` : "—");
  const usd = (n) => {
    if (!Number.isFinite(n) || n < 0) return "—";
    if (n >= 1e9) return `$${(n / 1e9).toLocaleString("en-US", { maximumFractionDigits: 2 })}B`;
    if (n >= 1e6) return `$${(n / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}M`;
    return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const lines = [];
  lines.push(`📊 **Token Stats — ${sym}**`);
  lines.push(`• Chain: **${card.chain || "—"}** · CA: \`${card.ca || "—"}\``);
  lines.push(`• Price: **${usd(card.price)}** · 24h: **${pct(card.price_change_24h_pct)}**`);
  lines.push(`• MCap: **${usd(card.mcap)}** · Vol 24h / 1h: **${usd(card.vol_24h)}** / **${usd(card.vol_1h)}**`);
  lines.push(`• LP: **${usd(card.lp_usd)}** · Supply: **${fmtNum(card.supply_total)}** (circ **${fmtNum(card.supply_circulating)}**, **${card.supply_pct.toFixed(1)}%**)`);
  lines.push("");
  lines.push(`📈 **Price Action**`);
  lines.push(`• 1h / 2h / 4h: **${pct(card.change_1h_pct)}** · **${pct(card.change_2h_pct)}** · **${pct(card.change_4h_pct)}**`);
  lines.push("");
  lines.push(`👥 **Trading Activity (24H)**`);
  lines.push(
    `• Traders: **${card.traders_24h}** · Trades: **${card.trades_24h}** · Buys / Sells: **${card.buy_tx_24h}** / **${card.sell_tx_24h}**`
  );
  lines.push(
    `• Buy/sell ratio: **${card.buy_sell_ratio_24h.toFixed(2)}** · 1h: **${card.buys_1h}** / **${card.sells_1h}** · ~15m: **${card.buys_15m}** / **${card.sells_15m}** (${card.trades_15m} swaps)`
  );
  lines.push("");
  lines.push(`🔥 **Trend:** **${card.trend_label}** (score **${card.trend_score}/100**)`);
  return lines.join("\n");
}

function fmtNum(n) {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/**
 * @param {string} poolAddress
 * @param {number} chainId
 * @param {string} indexerBase
 * @param {number} sinceSec24
 */
async function fetchSwapAggregates(poolAddress, chainId, indexerBase, sinceSec24) {
  const base = indexerBase.replace(/\/$/, "");
  const ts = String(sinceSec24);
  const t1 = nowSec() - 3600;
  const t15 = nowSec() - 900;

  const countQuery = (typeArg) =>
    `query ($pool: String!, $chainId: Int!, $ts: BigInt!) {
      swaps(where: { pool: $pool, chainId: $chainId, timestamp_gte: $ts${typeArg} }, limit: 1) { totalCount }
    }`;

  const runCount = async (typeFilter) => {
    try {
      const extra = typeFilter ? `, type: "${typeFilter}"` : "";
      const res = await fetch(`${base}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: countQuery(extra),
          variables: { pool: poolAddress, chainId, ts },
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (json.errors?.length) return 0;
      return Number(json.data?.swaps?.totalCount ?? 0) || 0;
    } catch {
      return 0;
    }
  };

  const itemsQuery = `query ($pool: String!, $chainId: Int!, $ts: BigInt!) {
    swaps(where: { pool: $pool, chainId: $chainId, timestamp_gte: $ts }, limit: 1000) {
      items { swapValueUsd type user timestamp }
    }
  }`;
  let trades24h = 0;
  let buyTx24h = 0;
  let sellTx24h = 0;
  let itemsRes = {};
  try {
    [trades24h, buyTx24h, sellTx24h, itemsRes] = await Promise.all([
      runCount(null),
      runCount("buy"),
      runCount("sell"),
      fetch(`${base}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: itemsQuery, variables: { pool: poolAddress, chainId, ts } }),
      }).then((r) => r.json().catch(() => ({}))),
    ]);
  } catch {
    itemsRes = {};
  }

  const items = itemsRes.data?.swaps?.items ?? [];
  let volUsdFromSwaps = 0;
  const users = new Set();
  let buys1h = 0;
  let sells1h = 0;
  let vol1hFromSwaps = 0;
  let buys15m = 0;
  let sells15m = 0;
  let trades15m = 0;
  for (const row of items) {
    volUsdFromSwaps += numFromScaled(row.swapValueUsd, USD_VOL_1E12);
    if (row.user) users.add(String(row.user).toLowerCase());
    const tst = Number(row.timestamp);
    if (!Number.isFinite(tst)) continue;
    if (tst >= t15) {
      trades15m++;
      if (row.type === "buy") buys15m++;
      else if (row.type === "sell") sells15m++;
    }
    if (tst >= t1) {
      if (row.type === "buy") buys1h++;
      else if (row.type === "sell") sells1h++;
      vol1hFromSwaps += numFromScaled(row.swapValueUsd, USD_VOL_1E12);
    }
  }

  if (items.length > 0 && trades24h > items.length && volUsdFromSwaps > 0) {
    const scale = Math.min(10, trades24h / items.length);
    volUsdFromSwaps *= scale;
    if (vol1hFromSwaps > 0) vol1hFromSwaps *= scale;
  }

  return {
    trades24h,
    buyTx24h,
    sellTx24h,
    volUsdFromSwaps,
    vol1hFromSwaps,
    tradersSample: users.size,
    buys1h,
    sells1h,
    buys15m,
    sells15m,
    trades15m,
  };
}

function sumBucketVolumeUsd(items, sinceSec) {
  let sum = 0;
  for (const b of items) {
    const mid = Number(b.minuteId);
    if (!Number.isFinite(mid) || mid < sinceSec) continue;
    sum += numFromScaled(b.volumeUsd, USD_1E18);
  }
  return sum;
}

function priceFromCloseScaled(closeRaw) {
  const n = numFromScaled(closeRaw, USD_1E18);
  return n > 0 ? n : 0;
}

/**
 * Derive % change from USD-scaled close prices (15m buckets).
 * @param {number} currentPx
 * @param {number} pastPx
 */
function pctChange(currentPx, pastPx) {
  if (!Number.isFinite(currentPx) || !Number.isFinite(pastPx) || pastPx <= 0) return 0;
  return ((currentPx - pastPx) / pastPx) * 100;
}

/**
 * @param {string} tokenAddress - 0x…40 hex
 * @param {{ dopplerIndexerUrl?: string, chainId?: number }} [options]
 * @returns {Promise<{ card: TrendCard, text: string }>}
 */
export async function buildTokenTrendCard(tokenAddress, options = {}) {
  const chainId = options.chainId ?? CHAIN_ID;
  const indexerBase = (options.dopplerIndexerUrl || process.env.DOPPLER_INDEXER_URL || DEFAULT_INDEXER).replace(
    /\/$/,
    ""
  );
  const addr = normalizeAddress(tokenAddress);
  if (!addr) {
    const empty = emptyCard("", chainId);
    return { card: empty, text: formatTrendCardText(empty) };
  }

  const addrEsc = addr.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const query = `query {
    tokens(where: { chainId: ${chainId}, address: "${addrEsc}" }, limit: 1) {
      items {
        address name symbol decimals totalSupply volumeUsd holderCount
        pool {
          address price dollarLiquidity volumeUsd percentDayChange marketCapUsd holderCount
          fifteenMinuteBucketUsds(limit: 120, orderBy: "minuteId", orderDirection: "desc") {
            items { minuteId volumeUsd count open close }
          }
          volumeBuckets24h(limit: 3, orderBy: "timestamp", orderDirection: "desc") {
            items {
              timestamp volumeUsd buyCount sellCount uniqueUsers txCount
              close marketCapUsd holderCount
            }
          }
        }
      }
    }
  }`;

  let token = null;
  try {
    const res = await fetch(`${indexerBase}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const json = await res.json().catch(() => ({}));
    const items = json.data?.tokens?.items ?? [];
    token = items[0] ?? null;
  } catch {
    token = null;
  }

  if (!token?.pool) {
    const empty = emptyCard(addr, chainId);
    empty.token = token?.name ? `${token.name} ($${token?.symbol || "?"})` : "";
    return { card: empty, text: formatTrendCardText(empty) };
  }

  const pool = token.pool;
  const poolAddr = pool.address;
  const decimals = Number(token.decimals) || 18;
  const supplyHuman = numFromScaled(token.totalSupply, 10 ** decimals);

  const mcap = numFromScaled(pool.marketCapUsd, USD_1E18);
  const lpUsd = numFromScaled(pool.dollarLiquidity, USD_1E18);
  const priceFromMcap = supplyHuman > 0 && mcap > 0 ? mcap / supplyHuman : 0;

  const buckets = pool.fifteenMinuteBucketUsds?.items ?? [];
  const tNow = nowSec();
  const t24 = tNow - 86400;
  const t1 = tNow - 3600;
  const t2 = tNow - 7200;
  const t4 = tNow - 14400;

  const vol24Buckets = sumBucketVolumeUsd(buckets, t24);
  const vol1Buckets = sumBucketVolumeUsd(buckets, t1);

  const sortedByMinute = [...buckets].sort((a, b) => Number(b.minuteId) - Number(a.minuteId));
  const latest = sortedByMinute[0];
  const currentPxFromBucket = latest ? priceFromCloseScaled(latest.close) : 0;
  const price = priceFromMcap > 0 ? priceFromMcap : currentPxFromBucket;

  function closeAtOrBefore(targetSec) {
    for (const b of sortedByMinute) {
      const mid = Number(b.minuteId);
      if (mid <= targetSec) return priceFromCloseScaled(b.close);
    }
    return 0;
  }

  const px1hAgo = closeAtOrBefore(t1);
  const px2hAgo = closeAtOrBefore(t2);
  const px4hAgo = closeAtOrBefore(t4);

  const change1hPct = pctChange(price || currentPxFromBucket, px1hAgo);
  const change2hPct = pctChange(price || currentPxFromBucket, px2hAgo);
  const change4hPct = pctChange(price || currentPxFromBucket, px4hAgo);

  const vb = pool.volumeBuckets24h?.items?.[0];
  let traders24h = vb?.uniqueUsers != null ? Number(vb.uniqueUsers) : 0;
  let trades24h = vb?.txCount != null ? Number(vb.txCount) : 0;
  let buyTx24h = vb?.buyCount != null ? Number(vb.buyCount) : 0;
  let sellTx24h = vb?.sellCount != null ? Number(vb.sellCount) : 0;
  let vol24h = vb?.volumeUsd != null ? numFromScaled(vb.volumeUsd, USD_1E18) : 0;
  let vol1h = 0;

  let buys1h = 0;
  let sells1h = 0;
  let buys15m = 0;
  let sells15m = 0;
  let trades15m = 0;
  if (poolAddr) {
    const sw = await fetchSwapAggregates(poolAddr, chainId, indexerBase, t24).catch(() => null);
    if (sw) {
      if (vol24h <= 0 && sw.volUsdFromSwaps > 0) vol24h = sw.volUsdFromSwaps;
      else if (sw.trades24h > 0 && sw.volUsdFromSwaps > 0) vol24h = Math.max(vol24h, sw.volUsdFromSwaps);
      if (trades24h <= 0) trades24h = sw.trades24h;
      if (buyTx24h + sellTx24h <= 0) {
        buyTx24h = sw.buyTx24h;
        sellTx24h = sw.sellTx24h;
      }
      traders24h = Math.max(traders24h, sw.tradersSample || 0);
      vol1h = Math.max(vol1Buckets, sw.vol1hFromSwaps || 0);
      buys1h = sw.buys1h;
      sells1h = sw.sells1h;
      buys15m = sw.buys15m ?? 0;
      sells15m = sw.sells15m ?? 0;
      trades15m = sw.trades15m ?? 0;
    }
  }

  if (vol1h <= 0) vol1h = vol1Buckets;
  if (vol24h <= 0) {
    vol24h = vol24Buckets;
    if (vol24h <= 0) vol24h = numFromScaled(pool.volumeUsd, USD_1E18);
    if (vol24h <= 0) vol24h = numFromScaled(token.volumeUsd, USD_1E18);
  }

  const poolVol = numFromScaled(pool.volumeUsd, USD_1E18);
  if (poolVol > vol24h) vol24h = poolVol;

  const pctDay = Number(pool.percentDayChange);
  const price_change_24h_pct = Number.isFinite(pctDay) ? pctDay : 0;

  const ratio =
    sellTx24h > 0 ? buyTx24h / sellTx24h : buyTx24h > 0 ? buyTx24h : 0;

  const trend_score = computeTrendScore({
    change1hPct: change1hPct,
    change2hPct: change2hPct,
    change4hPct: change4hPct,
    vol1h: vol1h,
    vol24h: vol24h,
    traders24h: traders24h,
    trades24h: trades24h,
    buyTx24h: buyTx24h,
    sellTx24h: sellTx24h,
  });
  const trend_label = scoreToLabel(trend_score);

  const name = token.name || "";
  const sym = token.symbol || "";
  const tokenLabel = name ? `${name} ($${sym})` : sym || "";

  const card = {
    token: tokenLabel,
    chain: CHAIN_NAMES[chainId] || `chain-${chainId}`,
    ca: addr,
    price: roundOrZero(price, 8),
    price_change_24h_pct: roundOrZero(price_change_24h_pct, 4),
    mcap: roundOrZero(mcap, 2),
    vol_24h: roundOrZero(vol24h, 2),
    vol_1h: roundOrZero(vol1h, 2),
    lp_usd: roundOrZero(lpUsd, 2),
    supply_total: roundOrZero(supplyHuman, 2),
    supply_circulating: roundOrZero(supplyHuman, 2),
    supply_pct: supplyHuman > 0 ? 100 : 0,
    change_1h_pct: roundOrZero(change1hPct, 4),
    change_2h_pct: roundOrZero(change2hPct, 4),
    change_4h_pct: roundOrZero(change4hPct, 4),
    buys_1h: buys1h,
    sells_1h: sells1h,
    buys_15m: buys15m,
    sells_15m: sells15m,
    trades_15m: trades15m,
    traders_24h: traders24h,
    trades_24h: trades24h,
    buy_tx_24h: buyTx24h,
    sell_tx_24h: sellTx24h,
    buy_sell_ratio_24h: roundOrZero(ratio, 4),
    trend_score,
    trend_label,
  };

  return { card, text: formatTrendCardText(card) };
}

/**
 * Slim snapshot for Discord embeds / monitoring (same GraphQL + swap path as {@link buildTokenTrendCard}).
 * @param {string} tokenAddress
 * @param {{ dopplerIndexerUrl?: string, chainId?: number }} [options]
 * @returns {Promise<IndexerTradingSnapshot | null>}
 */
export async function fetchIndexerTradingSnapshot(tokenAddress, options = {}) {
  try {
    const { card } = await buildTokenTrendCard(tokenAddress, options);
    if (!card?.ca) return null;
    const has =
      card.vol_24h > 0 ||
      card.vol_1h > 0 ||
      card.trades_24h > 0 ||
      card.mcap > 0 ||
      card.lp_usd > 0 ||
      card.buy_tx_24h + card.sell_tx_24h > 0 ||
      card.buys_1h + card.sells_1h > 0 ||
      Math.abs(card.change_1h_pct) > 1e-9 ||
      card.trend_score > 0;
    if (!has) return null;
    return {
      vol24h: card.vol_24h,
      vol1h: card.vol_1h,
      buyTx24h: card.buy_tx_24h,
      sellTx24h: card.sell_tx_24h,
      buys1h: card.buys_1h,
      sells1h: card.sells_1h,
      trades24h: card.trades_24h,
      traders24h: card.traders_24h,
      mcapUsd: card.mcap,
      lpUsd: card.lp_usd,
      priceChange24hPct: card.price_change_24h_pct,
      change1hPct: card.change_1h_pct,
      change2hPct: card.change_2h_pct,
      change4hPct: card.change_4h_pct,
      trendScore: card.trend_score,
      trendLabel: card.trend_label,
      buySellRatio24h: card.buy_sell_ratio_24h,
      price: card.price,
    };
  } catch {
    return null;
  }
}

function roundOrZero(n, d) {
  if (!Number.isFinite(n)) return 0;
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

function emptyCard(ca, chainId) {
  const z = 0;
  return {
    token: "",
    chain: CHAIN_NAMES[chainId] || `chain-${chainId}`,
    ca: ca || "",
    price: z,
    price_change_24h_pct: z,
    mcap: z,
    vol_24h: z,
    vol_1h: z,
    lp_usd: z,
    supply_total: z,
    supply_circulating: z,
    supply_pct: z,
    change_1h_pct: z,
    change_2h_pct: z,
    change_4h_pct: z,
    buys_1h: z,
    sells_1h: z,
    buys_15m: z,
    sells_15m: z,
    trades_15m: z,
    traders_24h: z,
    trades_24h: z,
    buy_tx_24h: z,
    sell_tx_24h: z,
    buy_sell_ratio_24h: z,
    trend_score: z,
    trend_label: "NOT_TRENDING",
  };
}

/**
 * Flat metrics for per-token activity watch thresholds (same GraphQL + swap sample as trend card).
 * 15m/1h counts are from the last **1000** swaps in 24h — very active pools may undercount.
 * @param {string} tokenAddress
 * @param {{ dopplerIndexerUrl?: string, chainId?: number }} [options]
 */
export async function fetchTokenActivityWatchMetrics(tokenAddress, options = {}) {
  const { card } = await buildTokenTrendCard(tokenAddress, options);
  if (!card?.ca) return null;
  return {
    tokenAddress: card.ca,
    label: card.token || null,
    mcapUsd: card.mcap,
    vol1hUsd: card.vol_1h,
    vol24hUsd: card.vol_24h,
    buys15m: card.buys_15m,
    sells15m: card.sells_15m,
    trades15m: card.trades_15m,
    buys1h: card.buys_1h,
    sells1h: card.sells_1h,
    buys24h: card.buy_tx_24h,
    sells24h: card.sell_tx_24h,
    trades24h: card.trades_24h,
    trendScore: card.trend_score,
    trendLabel: card.trend_label,
  };
}

function normalizeAddress(addr) {
  if (!addr || typeof addr !== "string") return null;
  const s = addr.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(s)) return null;
  return s;
}

export { CHAIN_ID, DEFAULT_INDEXER as DOPPLER_INDEXER_DEFAULT };

const isMain = /(?:^|[\\/])token-trend-card\.js$/.test(String(process.argv[1] || "").replace(/\\/g, "/"));
if (isMain) {
  const addr = process.argv[2];
  if (!addr) {
    console.error("Usage: node src/token-trend-card.js <tokenAddress>");
    process.exit(1);
  }
  buildTokenTrendCard(addr)
    .then(({ card }) => console.log(JSON.stringify(card, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
