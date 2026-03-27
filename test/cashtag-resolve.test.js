import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractTickers, CASHTAG_RE } from "../src/cashtag-resolve.js";

describe("extractTickers", () => {
  it("dedupes and uppercases", () => {
    assert.deepEqual(extractTickers("alpha $tst and $TST beta"), ["TST"]);
  });
  it("returns multiple in order", () => {
    assert.deepEqual(extractTickers("$FOO $BAR"), ["FOO", "BAR"]);
  });
  it("ignores single char after $", () => {
    assert.deepEqual(extractTickers("$X $AB"), ["AB"]);
  });
});

describe("CASHTAG_RE", () => {
  it("matches word boundary after ticker", () => {
    const first = [...("$TST.".matchAll(CASHTAG_RE))][0];
    assert.ok(first);
    assert.equal(first[1], "TST");
  });
});
