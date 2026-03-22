/**
 * Schedule Telegram *personal* DMs (opt-in users) with a delay so Discord stays fastest.
 * Uses TELEGRAM_DM_DELAY_MS or falls back to TELEGRAM_HOT_PING_DELAY_MS (default 60s).
 */

import { sendTelegram, sendTelegramHotPing, sendTelegramClaim } from "./notify.js";
import {
  isPersonalDmsEnabled,
  getAllPersonalUsers,
  isChatAllowedForPersonalFeatures,
  userToWatchListSets,
  userMatchesClaim,
} from "./telegram-personal-store.js";
import { isWatchMatchForTenant } from "./watch-match.js";

const STAGGER_MS = 50;

export function getTelegramPersonalDmDelayMs() {
  const dm = parseInt(process.env.TELEGRAM_DM_DELAY_MS ?? "", 10);
  if (!Number.isNaN(dm) && dm >= 0) return dm;
  const hot = parseInt(process.env.TELEGRAM_HOT_PING_DELAY_MS ?? "60000", 10);
  return Math.max(0, Number.isNaN(hot) ? 60000 : hot);
}

/** After Discord + group Telegram paths run for a new launch, queue delayed personal DMs. */
export function schedulePersonalLaunchDms(launch) {
  if (!isPersonalDmsEnabled() || !process.env.TELEGRAM_BOT_TOKEN) return;
  const delay = getTelegramPersonalDmDelayMs();
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
    const prepend = "🔔 *Watch list match*";
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

/** After on-chain claim is handled for Discord/group, queue delayed personal claim DMs. */
export function schedulePersonalClaimDms(claim) {
  if (!isPersonalDmsEnabled() || !process.env.TELEGRAM_BOT_TOKEN) return;
  const delay = getTelegramPersonalDmDelayMs();
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
          prependMarkdown: "💰 *Claim alert*",
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
