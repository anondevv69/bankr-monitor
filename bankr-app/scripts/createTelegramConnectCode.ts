const apiUrl = await secrets.get("BANKR_MONITOR_API_URL");
const apiToken = await secrets.get("BANKR_MONITOR_API_TOKEN");
const walletAddress = ctx.caller.walletAddress;

if (!walletAddress) {
  return { ok: false, error: "Sign in with Bankr to connect Telegram." };
}

const base = String(apiUrl).replace(/\/+$/, "");
return await http.fetch(`${base}/api/app/telegram/connect-code`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${apiToken}`,
    "x-bankr-app-token": String(apiToken),
    "content-type": "application/json",
  },
  body: JSON.stringify({ walletAddress }),
});
