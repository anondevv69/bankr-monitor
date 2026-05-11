/**
 * Alert fanout for users configured through the Bankr Apps control panel.
 */

import { buildLaunchEmbed, sendTelegram, sendTelegramHotPing } from "./notify.js";
import { isWatchMatchForTenant, getWatchMatchReasons } from "./watch-match.js";
import {
  bankrAppAlertsEnabled,
  bankrAppUserToWatchListSets,
  listActiveBankrAppUsers,
} from "./bankr-app-store.js";

const STAGGER_MS = 75;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postDiscordWebhook(webhookUrl, payload) {
  if (!webhookUrl) return false;
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord webhook ${res.status}: ${text.slice(0, 160)}`);
  }
  return true;
}

function escapeTgMarkdown(s) {
  if (!s || typeof s !== "string") return "";
  return s.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

export async function sendBankrAppTestDiscordWebhook(webhookUrl, walletAddress) {
  return postDiscordWebhook(webhookUrl, {
    content:
      `BankrMonitor test ping for \`${String(walletAddress || "Bankr App user").slice(0, 64)}\`.\n` +
      "If you see this, the webhook destination is connected.",
  });
}

async function getActiveUsersSafe() {
  if (!bankrAppAlertsEnabled()) return [];
  try {
    return await listActiveBankrAppUsers();
  } catch (e) {
    console.error("[bankr-app] load users failed:", e?.message ?? e);
    return [];
  }
}

export function scheduleBankrAppLaunchWebhooks(launch) {
  if (!bankrAppAlertsEnabled()) return;
  setTimeout(() => {
    void fanOutBankrAppLaunchWebhooks(launch);
  }, 0);
}

async function fanOutBankrAppLaunchWebhooks(launch) {
  const users = await getActiveUsersSafe();
  let i = 0;
  for (const user of users) {
    if (user.settings?.launchAlerts === false) continue;
    const webhookUrl = user.destinations?.discordWebhookUrl;
    const watchList = bankrAppUserToWatchListSets(user);
    if (!isWatchMatchForTenant(launch, watchList)) continue;
    const reasons = getWatchMatchReasons(launch, watchList);
    const embed = buildLaunchEmbed({
      ...launch,
      watchMatchReasons: reasons,
    });
    embed.title = `Watch match: ${launch.name} ($${launch.symbol})`;
    const telegramChatId = user.settings?.telegramDms !== false ? user.destinations?.telegramChatId : null;
    if (!webhookUrl && !telegramChatId) continue;
    const idx = i++;
    setTimeout(() => {
      if (webhookUrl) {
        void postDiscordWebhook(webhookUrl, {
          content: "**BankrMonitor watchlist match**",
          embeds: [embed],
        }).catch((e) => console.error("[bankr-app] watch webhook failed:", e?.message ?? e));
      }
      if (telegramChatId) {
        const bullets = reasons.length > 0 ? reasons.map((r) => `• ${escapeTgMarkdown(r)}`).join("\n") : "";
        const prependMarkdown = bullets ? `🔔 *BankrMonitor watchlist match*\n${bullets}` : "🔔 *BankrMonitor watchlist match*";
        void sendTelegram(launch, {
          chatId: telegramChatId,
          skipAllowedCheck: true,
          prependMarkdown,
        }).catch((e) => console.error("[bankr-app] watch Telegram failed:", e?.message ?? e));
      }
    }, idx * STAGGER_MS);
  }
}

/**
 * Hot/trending alerts are broadcast-style per user setting, not watchlist-bound.
 */
export function scheduleBankrAppHotTrendingWebhooks(launchForEmbed, hotStats, { isHot, isTrending } = {}) {
  if (!bankrAppAlertsEnabled() || (!isHot && !isTrending)) return;
  setTimeout(() => {
    void fanOutBankrAppHotTrendingWebhooks(launchForEmbed, hotStats, { isHot, isTrending });
  }, 0);
}

async function fanOutBankrAppHotTrendingWebhooks(launchForEmbed, hotStats, { isHot, isTrending }) {
  const users = await getActiveUsersSafe();
  let i = 0;
  for (const user of users) {
    const webhookUrl = user.destinations?.discordWebhookUrl;
    const telegramChatId = user.settings?.telegramDms !== false ? user.destinations?.telegramChatId : null;
    if (!webhookUrl && !telegramChatId) continue;
    const wantsHot = isHot && user.settings?.hot === true;
    const wantsTrending = isTrending && user.settings?.trending !== false;
    if (!wantsHot && !wantsTrending) continue;
    const embed = buildLaunchEmbed(launchForEmbed);
    if (wantsHot) {
      embed.color = 0xff6600;
      embed.title = `Hot: ${launchForEmbed.name} ($${launchForEmbed.symbol})`;
    } else {
      embed.color = 0x5865f2;
      embed.title = `Trending: ${launchForEmbed.name} ($${launchForEmbed.symbol})`;
    }
    const content = wantsHot && wantsTrending ? "**BankrMonitor hot/trending token**" : wantsHot ? "**BankrMonitor hot token**" : "**BankrMonitor trending token**";
    const idx = i++;
    setTimeout(() => {
      if (webhookUrl) {
        void postDiscordWebhook(webhookUrl, { content, embeds: [embed] }).catch((e) =>
          console.error("[bankr-app] hot/trending webhook failed:", e?.message ?? e)
        );
      }
      if (telegramChatId) {
        if (wantsHot) {
          void sendTelegramHotPing(launchForEmbed, hotStats, {
            chatId: telegramChatId,
            skipAllowedCheck: true,
            skipPin: true,
            prependMarkdown: "🔥 *BankrMonitor hot token*",
          }).catch((e) => console.error("[bankr-app] hot Telegram failed:", e?.message ?? e));
        }
        if (wantsTrending) {
          void sendTelegramHotPing(launchForEmbed, hotStats, {
            chatId: telegramChatId,
            skipAllowedCheck: true,
            skipPin: true,
            trending: true,
            prependMarkdown: "📈 *BankrMonitor trending token*",
          }).catch((e) => console.error("[bankr-app] trending Telegram failed:", e?.message ?? e));
        }
      }
    }, idx * STAGGER_MS);
  }
  if (i > 0) await sleep(0);
}

