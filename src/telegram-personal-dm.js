/**
 * Schedule Telegram *personal* DMs.
 * - Watchlist launch + claim DMs: immediate by default (same time we process the event).
 * - Hot/trending personal DMs: TELEGRAM_DM_DELAY_MS or TELEGRAM_HOT_PING_DELAY_MS (default 60s).
 */

import { sendTelegram, sendTelegramHotPing, sendTelegramClaim } from "./notify.js";
import {
  isPersonalDmsEnabled,
  getAllPersonalUsers,
  isChatAllowedForPersonalFeatures,
  userToWatchListSets,
  userMatchesClaim,
  getClaimMatchReasons,
} from "./telegram-personal-store.js";
import { isWatchMatchForTenant, getWatchMatchReasons } from "./watch-match.js";

const STAGGER_MS = 50;

/** Telegram Markdown (legacy) escape — same rules as notify.js */
function escapeTgMarkdown(s) {
  if (!s || typeof s !== "string") return "";
  return s.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

/** Prepend line(s) for personal DM: why this launch matched the user's watchlist */
function buildPersonalWatchlistPrepend(launch, watchList) {
  const reasons = getWatchMatchReasons(launch, watchList);
  if (reasons.length === 0) {
    return "🔔 *Watch list match*";
  }
  const bullets = reasons.map((r) => `• ${escapeTgMarkdown(r)}`).join("\n");
  return `🔔 *Watch list match*\n_Matched because:_\n${bullets}`;
}

function buildPersonalClaimPrepend(user, claim) {
  const reasons = getClaimMatchReasons(user, claim);
  if (reasons.length === 0) {
    return "💰 *Claim alert*";
  }
  const bullets = reasons.map((r) => `• ${escapeTgMarkdown(r)}`).join("\n");
  return `💰 *Claim alert*\n_Matched because:_\n${bullets}`;
}

/** Delay before personal *hot/trending* DMs (keeps group/DM hot+trending behind Discord if configured). */
export function getTelegramPersonalDmDelayMs() {
  const dm = parseInt(process.env.TELEGRAM_DM_DELAY_MS ?? "", 10);
  if (!Number.isNaN(dm) && dm >= 0) return dm;
  const hot = parseInt(process.env.TELEGRAM_HOT_PING_DELAY_MS ?? "60000", 10);
  return Math.max(0, Number.isNaN(hot) ? 60000 : hot);
}

/** Optional extra delay for watchlist launch/claim DMs (default 0 = fire with the firehose pipeline). */
export function getTelegramPersonalWatchlistDmDelayMs() {
  const w = parseInt(process.env.TELEGRAM_DM_WATCHLIST_DELAY_MS ?? "", 10);
  if (!Number.isNaN(w) && w >= 0) return w;
  return 0;
}

/** After Discord + group Telegram paths run for a new launch, queue personal watchlist DMs (no hot/trending delay by default). */
export function schedulePersonalLaunchDms(launch) {
  if (!isPersonalDmsEnabled() || !process.env.TELEGRAM_BOT_TOKEN) return;
  const delay = getTelegramPersonalWatchlistDmDelayMs();
  setTimeout(() => {
    void fanOutLaunchDms(launch);
  }, delay);
}

async function fanOutLaunchDms(launch) {
  let users;
  try {
    users = await getAllPersonalUsers();
  } catch {
    return;
  }
  let i = 0;
  for (const user of users) {
    if (!isChatAllowedForPersonalFeatures(user.chatId)) continue;
    const wlLen = user.watchlist?.length ?? 0;
    if (wlLen === 0) continue;
    const wl = userToWatchListSets(user);
    const matchWatch = user.settings.launchAlerts !== false && isWatchMatchForTenant(launch, wl);
    if (!matchWatch) continue;
    const idx = i++;
    const prepend = buildPersonalWatchlistPrepend(launch, wl);
    setTimeout(async () => {
      try {
        await sendTelegram(launch, {
          chatId: user.chatId,
          skipAllowedCheck: true,
          prependMarkdown: prepend,
        });
      } catch (_) {}
    }, idx * STAGGER_MS);
  }
}

/** After on-chain claim is handled for Discord/group, queue personal claim DMs (same timing as watchlist launches by default). */
export function schedulePersonalClaimDms(claim) {
  if (!isPersonalDmsEnabled() || !process.env.TELEGRAM_BOT_TOKEN) return;
  const delay = getTelegramPersonalWatchlistDmDelayMs();
  setTimeout(() => {
    void fanOutClaimDms(claim);
  }, delay);
}

async function fanOutClaimDms(claim) {
  let users;
  try {
    users = await getAllPersonalUsers();
  } catch {
    return;
  }
  let i = 0;
  for (const user of users) {
    if (!isChatAllowedForPersonalFeatures(user.chatId)) continue;
    if (!(user.watchlist?.length > 0)) continue;
    if (!userMatchesClaim(user, claim)) continue;
    const idx = i++;
    setTimeout(async () => {
      try {
        await sendTelegramClaim(claim, {
          chatId: user.chatId,
          skipAllowedCheck: true,
          prependMarkdown: buildPersonalClaimPrepend(user, claim),
        });
      } catch (_) {}
    }, idx * STAGGER_MS);
  }
}

/**
 * After Discord hot/trending embeds are sent, schedule personal hot/trending DMs (same extra delay).
 * @param {object} launchForEmbed
 * @param {object} hotStats — same shape as sendTelegramHotPing expects
 * @param {{ isHot: boolean, isTrending: boolean }} flags
 */
export function schedulePersonalHotTrendingDms(launchForEmbed, hotStats, flags) {
  if (!isPersonalDmsEnabled() || !process.env.TELEGRAM_BOT_TOKEN) return;
  const { isHot, isTrending } = flags;
  if (!isHot && !isTrending) return;
  const delay = getTelegramPersonalDmDelayMs();
  setTimeout(() => {
    void fanOutHotTrendingDms(launchForEmbed, hotStats, { isHot, isTrending });
  }, delay);
}

async function fanOutHotTrendingDms(launchForEmbed, hotStats, { isHot, isTrending }) {
  let users;
  try {
    users = await getAllPersonalUsers();
  } catch {
    return;
  }
  let i = 0;
  for (const user of users) {
    if (!isChatAllowedForPersonalFeatures(user.chatId)) continue;
    const wantHot = isHot && user.settings.hot === true;
    const wantTrend = isTrending && user.settings.trending !== false;
    if (!wantHot && !wantTrend) continue;
    const idx = i++;
    setTimeout(async () => {
      try {
        if (wantHot) {
          await sendTelegramHotPing(launchForEmbed, hotStats, {
            chatId: user.chatId,
            skipAllowedCheck: true,
            skipPin: true,
            prependMarkdown: "🔥 *Hot*",
          });
        }
        if (wantTrend) {
          await sendTelegramHotPing(launchForEmbed, hotStats, {
            chatId: user.chatId,
            skipAllowedCheck: true,
            skipPin: true,
            trending: true,
            prependMarkdown: "📈 *Trending*",
          });
        }
      } catch (_) {}
    }, idx * STAGGER_MS);
  }
}
