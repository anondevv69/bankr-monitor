const apiUrl = await secrets.get("BANKR_MONITOR_API_URL");
const apiToken = await secrets.get("BANKR_MONITOR_API_TOKEN");
const walletAddress = ctx.caller.walletAddress;

if (!walletAddress) {
  return { ok: false, error: "Sign in with Bankr to prepare a trade." };
}

const base = String(apiUrl).replace(/\/+$/, "");
const check = await http.fetch(
  `${base}/api/app/pending-trade?walletAddress=${encodeURIComponent(walletAddress)}`,
  {
    method: "GET",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "x-bankr-app-token": String(apiToken),
    },
  }
);

const pending = check?.pendingTrade;
if (!pending?.tokenAddress) {
  return { ok: true, pendingTrade: null, txBlob: null };
}

const tradeId = args?.tradeId != null ? String(args.tradeId) : pending.id;
if (tradeId && pending.id && tradeId !== pending.id) {
  return { ok: false, error: "Pending trade id mismatch." };
}

const amount = Number(pending.amountUsdc) > 0 ? Number(pending.amountUsdc) : 1;
const symbol = pending.symbol || "token";
const token = pending.tokenAddress;
const label = `BankrMonitor: swap $${amount} USDC to ${symbol} (${token}) on base`;

const me = await bankr.wallet.me();
log("executeAutoTrade", { wallet: me.evmAddress, token, amount });

let txBlob = null;
const swapApi = bankr.swap;
if (swapApi && typeof swapApi.prepare === "function") {
  txBlob = await swapApi.prepare({
    chain: "base",
    fromToken: "USDC",
    toToken: token,
    amountUsd: amount,
    label,
  });
} else {
  txBlob = await bankr.tx.prepare({
    chain: "base",
    to: token,
    data: "0x",
    value: "0",
    label,
  });
}

return {
  ok: true,
  pendingTrade: pending,
  txBlob,
  label,
};
