const apiUrl = await secrets.get("BANKR_MONITOR_API_URL");
const apiToken = await secrets.get("BANKR_MONITOR_API_TOKEN");

const base = String(apiUrl).replace(/\/+$/, "");
const limit = args?.limit ?? 40;
const type = args?.type ?? "trending";

return await http.fetch(
  `${base}/api/app/trending-feed?limit=${encodeURIComponent(String(limit))}&type=${encodeURIComponent(String(type))}`,
  {
    method: "GET",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "x-bankr-app-token": String(apiToken),
    },
  }
);
