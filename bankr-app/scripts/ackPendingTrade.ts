const apiUrl = await secrets.get("BANKR_MONITOR_API_URL");
const apiToken = await secrets.get("BANKR_MONITOR_API_TOKEN");
const walletAddress = ctx.caller.walletAddress;

if (!walletAddress) {
  return { ok: false, error: "Sign in with Bankr to acknowledge trades." };
}

const base = String(apiUrl).replace(/\/+$/, "");
const status = args?.status != null ? String(args.status) : "dismissed";
const tradeId = args?.tradeId != null ? String(args.tradeId) : undefined;

return await http.fetch(`${base}/api/app/pending-trade/ack`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${apiToken}`,
    "x-bankr-app-token": String(apiToken),
    "content-type": "application/json",
  },
  body: JSON.stringify({ walletAddress, status, tradeId }),
});
