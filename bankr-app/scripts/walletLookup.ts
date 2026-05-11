const apiUrl = await secrets.get("BANKR_MONITOR_API_URL");
const apiToken = await secrets.get("BANKR_MONITOR_API_TOKEN");
const walletAddress = ctx.caller.walletAddress;

if (!walletAddress) {
  return { ok: false, error: "Sign in with Bankr to run wallet lookup." };
}

const query = String(args.query || "").trim();
if (!query) {
  return { ok: false, error: "Enter an X handle, Farcaster handle, profile URL, or wallet." };
}

const base = String(apiUrl).replace(/\/+$/, "");
return await http.fetch(`${base}/api/app/wallet-lookup`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${apiToken}`,
    "x-bankr-app-token": String(apiToken),
    "content-type": "application/json",
  },
  body: JSON.stringify({
    walletAddress,
    query,
  }),
});
