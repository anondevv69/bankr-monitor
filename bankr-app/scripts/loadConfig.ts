const apiUrl = await secrets.get("BANKR_MONITOR_API_URL");
const apiToken = await secrets.get("BANKR_MONITOR_API_TOKEN");
const walletAddress = ctx.caller.walletAddress;

if (!walletAddress) {
  return { ok: false, error: "Sign in with Bankr to load your monitor settings." };
}

const base = String(apiUrl).replace(/\/+$/, "");
return await http.fetch(`${base}/api/app/config?walletAddress=${encodeURIComponent(walletAddress)}`, {
  method: "GET",
  headers: {
    authorization: `Bearer ${apiToken}`,
    "x-bankr-app-token": String(apiToken),
  },
});
