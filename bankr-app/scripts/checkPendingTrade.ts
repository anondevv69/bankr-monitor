const apiUrl = await secrets.get("BANKR_MONITOR_API_URL");
const apiToken = await secrets.get("BANKR_MONITOR_API_TOKEN");
const walletAddress = ctx.caller.walletAddress;

if (!walletAddress) {
  return { ok: false, error: "Sign in with Bankr to check pending trades." };
}

const base = String(apiUrl).replace(/\/+$/, "");
const data = await http.fetch(
  `${base}/api/app/pending-trade?walletAddress=${encodeURIComponent(walletAddress)}`,
  {
    method: "GET",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "x-bankr-app-token": String(apiToken),
    },
  }
);

return {
  ok: data?.ok !== false,
  pendingTrade: data?.pendingTrade ?? null,
};
