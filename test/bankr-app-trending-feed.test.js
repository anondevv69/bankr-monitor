import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { listTrendingFeed } from "../src/bankr-app-trending-feed.js";

describe("bankr-app trending feed", () => {
  it("returns an entries array", async () => {
    const feed = await listTrendingFeed({ limit: 5, type: "trending" });
    assert.ok(Array.isArray(feed.entries));
    assert.equal(typeof feed.total, "number");
  });
});
