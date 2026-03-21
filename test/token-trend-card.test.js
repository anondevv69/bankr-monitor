import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  scoreToLabel,
  computeTrendScore,
  formatTrendCardText,
  numFromScaled,
} from "../src/token-trend-card.js";

describe("scoreToLabel", () => {
  it("maps HOT at >= 75", () => {
    assert.equal(scoreToLabel(75), "HOT");
    assert.equal(scoreToLabel(100), "HOT");
  });
  it("maps TRENDING for 55–74", () => {
    assert.equal(scoreToLabel(55), "TRENDING");
    assert.equal(scoreToLabel(74), "TRENDING");
  });
  it("maps WARM for 35–54", () => {
    assert.equal(scoreToLabel(35), "WARM");
    assert.equal(scoreToLabel(54), "WARM");
  });
  it("maps NOT_TRENDING below 35", () => {
    assert.equal(scoreToLabel(34), "NOT_TRENDING");
    assert.equal(scoreToLabel(0), "NOT_TRENDING");
  });
  it("handles NaN as NOT_TRENDING", () => {
    assert.equal(scoreToLabel(NaN), "NOT_TRENDING");
  });
});

describe("computeTrendScore → label branches", () => {
  const base = {
    change1hPct: 0,
    change2hPct: 0,
    change4hPct: 0,
    vol1h: 0,
    vol24h: 0,
    traders24h: 0,
    trades24h: 0,
    buyTx24h: 0,
    sellTx24h: 0,
  };

  it("all flat → NOT_TRENDING", () => {
    const s = computeTrendScore(base);
    assert.ok(s < 35);
    assert.equal(scoreToLabel(s), "NOT_TRENDING");
  });

  it("strong buy pressure + moderate activity → at least WARM", () => {
    const s = computeTrendScore({
      ...base,
      vol1h: 5000,
      vol24h: 5000,
      traders24h: 40,
      trades24h: 200,
      buyTx24h: 180,
      sellTx24h: 20,
      change1hPct: 2,
      change2hPct: 2,
      change4hPct: 2,
    });
    assert.ok(s >= 35, `expected WARM+ got score ${s}`);
    assert.ok(["WARM", "TRENDING", "HOT"].includes(scoreToLabel(s)));
  });

  it("moderate mix → WARM (35–54)", () => {
    const s = computeTrendScore({
      ...base,
      change1hPct: 6,
      change2hPct: 5,
      change4hPct: 4,
      vol1h: 6000,
      vol24h: 9000,
      traders24h: 50,
      trades24h: 220,
      buyTx24h: 120,
      sellTx24h: 100,
    });
    assert.ok(s >= 35 && s < 55, `expected WARM band got ${s}`);
    assert.equal(scoreToLabel(s), "WARM");
  });

  it("extreme momentum + volume + traders + buys → HOT", () => {
    const s = computeTrendScore({
      ...base,
      change1hPct: 25,
      change2hPct: 25,
      change4hPct: 25,
      vol1h: 500_000,
      vol24h: 50_000,
      traders24h: 500,
      trades24h: 5000,
      buyTx24h: 4500,
      sellTx24h: 500,
    });
    assert.ok(s >= 75, `expected HOT got score ${s}`);
    assert.equal(scoreToLabel(s), "HOT");
  });

  it("mid-range mix → TRENDING", () => {
    const s = computeTrendScore({
      ...base,
      change1hPct: 12,
      change2hPct: 11,
      change4hPct: 10,
      vol1h: 45_000,
      vol24h: 48_000,
      traders24h: 150,
      trades24h: 1200,
      buyTx24h: 550,
      sellTx24h: 350,
    });
    assert.ok(s >= 55 && s < 75, `expected TRENDING band got ${s}`);
    assert.equal(scoreToLabel(s), "TRENDING");
  });
});

describe("formatTrendCardText", () => {
  it("includes section headers", () => {
    const text = formatTrendCardText({
      token: "Test ($TST)",
      chain: "Base",
      ca: "0x1234567890123456789012345678901234567890",
      price: 1,
      price_change_24h_pct: 1.5,
      mcap: 1000,
      vol_24h: 500,
      vol_1h: 50,
      lp_usd: 200,
      supply_total: 1e6,
      supply_circulating: 1e6,
      supply_pct: 100,
      change_1h_pct: 1,
      change_2h_pct: 2,
      change_4h_pct: 3,
      buys_1h: 5,
      sells_1h: 2,
      traders_24h: 10,
      trades_24h: 20,
      buy_tx_24h: 12,
      sell_tx_24h: 8,
      buy_sell_ratio_24h: 1.5,
      trend_score: 60,
      trend_label: "TRENDING",
    });
    assert.match(text, /📊.*Token Stats/);
    assert.match(text, /📈.*Price Action/);
    assert.match(text, /👥.*Trading Activity \(24H\)/);
    assert.match(text, /TRENDING/);
  });
});

describe("numFromScaled", () => {
  it("returns 0 for null", () => {
    assert.equal(numFromScaled(null, 1e18), 0);
  });
});
