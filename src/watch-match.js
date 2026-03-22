/**
 * Shared launch vs watchlist matching (Discord tenant + Telegram personal DMs).
 * watchList shape: { x, fc, wallet, keywords } as Sets, optional tokenAddresses Set for token CA matches.
 */

/**
 * @param {object} launch
 * @param {{ x?: Set<string>, fc?: Set<string>, wallet?: Set<string>, keywords?: Set<string>, tokenAddresses?: Set<string> }} watchList
 */
export function isWatchMatchForTenant(launch, watchList) {
  const ca = launch?.tokenAddress ? String(launch.tokenAddress).trim().toLowerCase() : null;
  const tokenSet = watchList?.tokenAddresses ?? new Set();
  if (ca && tokenSet.size > 0 && tokenSet.has(ca)) return true;

  const normX = (u) => (u && typeof u === "string" ? u.replace(/^@/, "").trim().toLowerCase() : null);
  const normFc = (u) => (u && typeof u === "string" ? String(u).trim().toLowerCase() : null);
  const deployerX = launch.launcherX ? normX(String(launch.launcherX)) : null;
  const deployerFc = launch.launcherFarcaster ? normFc(String(launch.launcherFarcaster)) : null;
  const normAddr = (a) => (a && /^0x[a-fA-F0-9]{40}$/.test(String(a).trim()) ? String(a).trim().toLowerCase() : null);
  const launcherAddr = normAddr(launch.launcher);
  const feeAddrs = (launch.beneficiaries || [])
    .map((b) => (typeof b === "object" ? (b.beneficiary ?? b.address ?? b.wallet) : b))
    .map(normAddr)
    .filter(Boolean);
  const allWalletAddrs = [launcherAddr, ...feeAddrs].filter(Boolean);
  const searchText = `${launch.name || ""} ${launch.symbol || ""}`.toLowerCase();
  const watchX = watchList?.x ?? new Set();
  const watchFc = watchList?.fc ?? new Set();
  const watchWallet = watchList?.wallet ?? new Set();
  const watchKeywords = watchList?.keywords ?? new Set();
  const inWatchX = deployerX && watchX.has(deployerX);
  const inWatchFc = deployerFc && watchFc.has(deployerFc);
  const inWatchWallet = watchWallet.size > 0 && allWalletAddrs.some((a) => watchWallet.has(a));
  const inWatchKeyword = watchKeywords.size > 0 && [...watchKeywords].some((kw) => searchText.includes(String(kw).toLowerCase().trim()));
  return !!(inWatchX || inWatchFc || inWatchWallet || inWatchKeyword);
}

/**
 * @param {object} launch
 * @param {{ x?: Set<string>, fc?: Set<string>, wallet?: Set<string>, keywords?: Set<string>, tokenAddresses?: Set<string> }} watchList
 * @returns {string[]}
 */
export function getWatchMatchReasons(launch, watchList) {
  if (!watchList) return [];
  const reasons = [];
  const ca = launch?.tokenAddress ? String(launch.tokenAddress).trim().toLowerCase() : null;
  const tokenSet = watchList?.tokenAddresses ?? new Set();
  if (ca && tokenSet.has(ca)) {
    reasons.push(`Token CA \`${ca.slice(0, 6)}…${ca.slice(-4)}\` is on your watch list`);
  }

  const normX = (u) => (u && typeof u === "string" ? u.replace(/^@/, "").trim().toLowerCase() : null);
  const normFc = (u) => (u && typeof u === "string" ? String(u).trim().toLowerCase() : null);
  const normAddr = (a) => (a && /^0x[a-fA-F0-9]{40}$/.test(String(a).trim()) ? String(a).trim().toLowerCase() : null);
  const deployerX = launch.launcherX ? normX(String(launch.launcherX)) : null;
  const deployerFc = launch.launcherFarcaster ? normFc(String(launch.launcherFarcaster)) : null;
  const launcherAddr = normAddr(launch.launcher);
  const feeAddrs = (launch.beneficiaries || [])
    .map((b) => (typeof b === "object" ? (b.beneficiary ?? b.address ?? b.wallet) : b))
    .map(normAddr)
    .filter(Boolean);
  const allWalletAddrs = [launcherAddr, ...feeAddrs].filter(Boolean);
  const searchText = `${launch.name || ""} ${launch.symbol || ""}`.toLowerCase();
  const watchX = watchList?.x ?? new Set();
  const watchFc = watchList?.fc ?? new Set();
  const watchWallet = watchList?.wallet ?? new Set();
  const watchKeywords = watchList?.keywords ?? new Set();

  if (deployerX && watchX.has(deployerX)) {
    reasons.push(`Launcher X (@${deployerX}) is on your watch list`);
  }
  if (deployerFc && watchFc.has(deployerFc)) {
    reasons.push(`Launcher Farcaster (${deployerFc}) is on your watch list`);
  }
  const seenWalletMatch = new Set();
  for (const a of allWalletAddrs) {
    if (!watchWallet.has(a) || seenWalletMatch.has(a)) continue;
    seenWalletMatch.add(a);
    const short = `${a.slice(0, 6)}…${a.slice(-4)}`;
    const role = a === launcherAddr ? "launcher" : "fee recipient";
    reasons.push(`Wallet \`${short}\` on your watch list (matched as ${role})`);
  }
  for (const kw of watchKeywords) {
    const k = String(kw).toLowerCase().trim();
    if (!k || !searchText.includes(k)) continue;
    const displayKw = String(kw).trim();
    reasons.push(`Keyword “${displayKw}” appears in token name or symbol`);
  }
  return reasons;
}
