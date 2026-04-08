/**
 * Telegram group watchlist + hot/trending destination merging (Discord bot + standalone notify).
 * Does not import notify.js — callers pass sendTelegram to avoid circular deps.
 */

import { isWatchMatchForTenant, getWatchMatchReasons } from "./watch-match.js";
import { telegramGroupWatchListHasEntries } from "./telegram-group-settings.js";

/** Same rule as notify.js `allowedTelegramChat` (TELEGRAM_ALLOWED_CHAT_IDS). */
export function allowedTelegramChatOutbound(chatId) {
  if (!chatId) return false;
  if (process.env.TELEGRAM_ALLOWED_CHAT_IDS === undefined) return true;
  const list = String(process.env.TELEGRAM_ALLOWED_CHAT_IDS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const id = String(chatId).trim();
  return list.includes(id);
}

function escapeTgMd(s) {
  return String(s).replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

/**
 * @param {object} launchForEmbeds
 * @param {Awaited<ReturnType<import("./telegram-group-settings.js").listTelegramGroupAlertConfigs>>} telegramGroupConfigs
 * @param {{ sendTelegram: (launch: object, opts?: object) => Promise<void>, outboundDelayMs?: number }} io
 */
export async function sendTelegramGroupWatchMatches(launchForEmbeds, telegramGroupConfigs, io) {
  const { sendTelegram, outboundDelayMs = 0 } = io;
  if (!telegramGroupConfigs?.length) return;
  const schedule = (fn) => {
    if (outboundDelayMs <= 0) void fn();
    else setTimeout(fn, outboundDelayMs);
  };
  for (const cfg of telegramGroupConfigs) {
    if (!cfg.alertWatchMatch || !telegramGroupWatchListHasEntries(cfg.watchListSets)) continue;
    if (!isWatchMatchForTenant(launchForEmbeds, cfg.watchListSets)) continue;
    if (!allowedTelegramChatOutbound(cfg.chatId)) continue;
    const reasons = getWatchMatchReasons(launchForEmbeds, cfg.watchListSets);
    if (reasons.length === 0) continue;
    const lines = reasons.map((r) => `• ${escapeTgMd(r)}`);
    const prepend = `👀 *Watch list match*\n${lines.join("\n")}\n\n`;
    const tw = cfg.topicWatch != null && cfg.topicWatch !== "" ? cfg.topicWatch : undefined;
    schedule(() =>
      void sendTelegram(launchForEmbeds, {
        chatId: cfg.chatId,
        messageThreadId: tw,
        prependMarkdown: prepend,
      }).catch(() => {})
    );
  }
}

/**
 * @param {Awaited<ReturnType<import("./telegram-group-settings.js").listTelegramGroupAlertConfigs>>} telegramGroupConfigs
 * @param {{ chatId: string, messageThreadId?: number|string }[]} telegramHotTargets
 * @param {{ chatId: string, messageThreadId?: number|string }[]} telegramTrendingTargets
 * @param {Set<string>|string[]} telegramChatIds
 */
export function mergeTelegramGroupHotTrendingTargets(telegramGroupConfigs, telegramHotTargets, telegramTrendingTargets, telegramChatIds) {
  if (!telegramGroupConfigs?.length) return;
  for (const c of telegramGroupConfigs) {
    if (!allowedTelegramChatOutbound(c.chatId)) continue;
    const cid = String(c.chatId);
    if (c.alertHot) {
      if (c.topicHot != null && c.topicHot !== "") {
        const tid = typeof c.topicHot === "number" ? c.topicHot : parseInt(String(c.topicHot), 10);
        telegramHotTargets.push({ chatId: cid, messageThreadId: Number.isNaN(tid) ? c.topicHot : tid });
      } else if (telegramChatIds instanceof Set) {
        telegramChatIds.add(cid);
      } else if (Array.isArray(telegramChatIds) && !telegramChatIds.includes(cid)) {
        telegramChatIds.push(cid);
      }
    }
    if (c.alertTrending) {
      if (c.topicTrending != null && c.topicTrending !== "") {
        const tid = typeof c.topicTrending === "number" ? c.topicTrending : parseInt(String(c.topicTrending), 10);
        telegramTrendingTargets.push({ chatId: cid, messageThreadId: Number.isNaN(tid) ? c.topicTrending : tid });
      } else {
        telegramTrendingTargets.push({ chatId: cid, messageThreadId: undefined });
      }
    }
  }
}
