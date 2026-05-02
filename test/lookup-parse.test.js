import test from "node:test";
import assert from "node:assert/strict";
import { parseQuery, extractPrimaryLookupTarget } from "../src/lookup-deployer.js";

test("extractPrimaryLookupTarget strips pasted /lookup prefix before URL", () => {
  assert.equal(extractPrimaryLookupTarget("/lookup https://x.com/mert"), "https://x.com/mert");
});

test("extractPrimaryLookupTarget picks URL from chained slash commands", () => {
  assert.equal(extractPrimaryLookupTarget("/walletlookup /lookup https://x.com/mert"), "https://x.com/mert");
});

test("parseQuery resolves handle from messy pasted command + URL", () => {
  const a = parseQuery("/walletlookup /lookup https://x.com/someuser");
  assert.equal(a.normalized, "someuser");
  assert.equal(a.isWallet, false);
});

test("parseQuery keeps bare wallet address when embedded", () => {
  const w = "0x62Bcefd446f97526ECC1375D02e014cFb8b48BA3";
  const a = parseQuery(`prefix ${w} suffix`);
  assert.equal(a.normalized, w.toLowerCase());
  assert.equal(a.isWallet, true);
});
