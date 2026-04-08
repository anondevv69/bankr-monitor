/**
 * Hot/trending Telegram pings (shared by discord-bot and standalone notify.js).
 */

import { getHotTokenStats, formatUsd } from "./token-stats.js";
import { enrichLaunchWithBankrRoleCounts } from "./lookup-deployer.js";
import { schedulePersonalHotTrendingDms } from "./telegram-personal-dm.js";
import { isBankrTokenAddress } from "./bankr-token.js";
import { defaultBankrApiKey } from "./bankr-env-key.js";

const HOT_LAUNCH_ENABLED = process.env.HOT_LAUNCH_ENABLED !== "false" && process.env.HOT_LAUNCH_ENABLED !== "0";
const HOT_LAUNCH_MIN_BUYS_FIRST_MIN = Math.max(
  0,
  parseInt(process.env.HOT_LAUNCH_MIN_BUYS_FIRST_MIN || process.env.HOT_LAUNCH_MIN_BUYS_5M || "5", 10)
);
const HOT_LAUNCH_MIN_HOLDERS = Math.max(0, parseInt(process.env.HOT_LAUNCH_MIN_HOLDERS || "20", 10));
const TRENDING_MIN_BUYS_30M = Math.max(0, parseInt(process.env.TRENDING_MIN_BUYS_30M ?? "20", 10));
const TRENDING_MIN_BUYS_5M = Math.max(0, parseInt(process.env.TRENDING_MIN_BUYS_5M || "0", 10));
const TRENDING_MIN_BUYS_1H = Math.max(0, parseInt(process.env.TRENDING_MIN_BUYS_1H || "0", 10));
const HOT_LAUNCH_MIN_INDEXER_VOL_1H_USD = Math.max(0, parseFloat(process.env.HOT_LAUNCH_MIN_INDEXER_VOL_1H_USD || "0"));
const TRENDING_MIN_INDEXER_VOL_24H_USD = Math.max(0, parseFloat(process.env.TRENDING_MIN_INDEXER_VOL_24H_USD || "0"));
const HOT_LAUNCH_DELAY_MS = Math.max(30_000, parseInt(process.env.HOT_LAUNCH_DELAY_MS || "65000", 10));
const TELEGRAM_HOT_PING_DELAY_MS = Math.max(0, parseInt(process.env.TELEGRAM_HOT_PING_DELAY_MS || "30000", 10));

/** True when any hot/trending env threshold is set (used by notify.js + discord-bot). */
export function hasHotTrendingThresholdsConfigured() {
  return (
    HOT_LAUNCH_MIN_BUYS_FIRST_MIN > 0 ||
    HOT_LAUNCH_MIN_HOLDERS > 0 ||
    TRENDING_MIN_BUYS_30M > 0 ||
    TRENDING_MIN_BUYS_5M > 0 ||
    TRENDING_MIN_BUYS_1H > 0 ||
    HOT_LAUNCH_MIN_INDEXER_VOL_1H_USD > 0 ||
    TRENDING_MIN_INDEXER_VOL_24H_USD > 0
  );
}

/**
 * Sends hot/trending Telegram pings after stats are known (also used by discord-bot after Discord posts).
 * @param {typeof import("./notify.js").sendTelegramHotPing} params.sendTelegramHotPing
 */
export async function sendTelegramHotTrendingPings({
  sendTelegramHotPing,
  launchForEmbed,
  hotStats,
  isHot,
  isTrending,
  telegramChatIds = [],
  telegramHotTargets = [],
  telegramTrendingTargets = [],
  telegramDelayMs = TELEGRAM_HOT_PING_DELAY_MS,
}) {
  if (typeof sendTelegramHotPing !== "function") return;
  const sendTgHotTopics = isHot && (telegramHotTargets?.length > 0);
  const sendTgTrendingTopics = isTrending && (telegramTrendingTargets?.length > 0);
  const needsTelegramHotTrend =
    (isHot && ((telegramChatIds || []).length > 0 || sendTgHotTopics)) || sendTgTrendingTopics;
  if (!needsTelegramHotTrend) return;
  const runTelegramHotTrend = async () => {
    try {
      const seen = new Set();
      if (isHot) {
        for (const chatId of telegramChatIds || []) {
          const key = `g:${chatId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          await sendTelegramHotPing(launchForEmbed, hotStats, { chatId }).catch(() => {});
        }
        for (const t of telegramHotTargets || []) {
          const key = `h:${t.chatId}:${t.messageThreadId ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          await sendTelegramHotPing(launchForEmbed, hotStats, {
            chatId: t.chatId,
            messageThreadId: t.messageThreadId,
          }).catch(() => {});
        }
      }
      if (isTrending) {
        for (const t of telegramTrendingTargets || []) {
          const key = `tr:${t.chatId}:${t.messageThreadId ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          await sendTelegramHotPing(launchForEmbed, hotStats, {
            chatId: t.chatId,
            messageThreadId: t.messageThreadId,
            trending: true,
          }).catch(() => {});
        }
      }
    } catch (e) {
      console.error("Telegram hot/trending ping failed:", e.message);
    }
  };
  if (telegramDelayMs > 0) setTimeout(runTelegramHotTrend, telegramDelayMs);
  else void runTelegramHotTrend();
}

/**
 * Delayed DexScreener/indexer check → personal hot/trending DMs + Telegram (no Discord).
 * Used by standalone notify.js when only Telegram destinations exist.
 * @param {typeof import("./notify.js").sendTelegramHotPing} options.sendTelegramHotPing
 */
export function scheduleHotLaunchTelegramCheck(
  launch,
  {
    sendTelegramHotPing,
    telegramChatIds = [],
    telegramHotTargets = [],
    telegramTrendingTargets = [],
    bankrApiKey,
    telegramHotPingDelayMs: overrideDelayMs,
  } = {}
) {
  if (typeof sendTelegramHotPing !== "function") return;
  if (!isBankrTokenAddress(launch?.tokenAddress)) return;
  const hasHotDest = (telegramHotTargets?.length ?? 0) > 0;
  const hasTrendingDest = (telegramTrendingTargets?.length ?? 0) > 0;
  const hasTelegram = (telegramChatIds?.length ?? 0) > 0 || hasHotDest || hasTrendingDest;
  const telegramDelayMs = overrideDelayMs != null ? Math.max(0, Number(overrideDelayMs)) : TELEGRAM_HOT_PING_DELAY_MS;
  if (
    (HOT_LAUNCH_MIN_BUYS_FIRST_MIN <= 0 &&
      HOT_LAUNCH_MIN_HOLDERS <= 0 &&
      TRENDING_MIN_BUYS_30M <= 0 &&
      TRENDING_MIN_BUYS_5M <= 0 &&
      TRENDING_MIN_BUYS_1H <= 0 &&
      HOT_LAUNCH_MIN_INDEXER_VOL_1H_USD <= 0 &&
      TRENDING_MIN_INDEXER_VOL_24H_USD <= 0) ||
    !hasTelegram
  ) {
    return;
  }
  const apiKey = defaultBankrApiKey(bankrApiKey);
  setTimeout(async () => {
    try {
      const stats = await getHotTokenStats(launch.tokenAddress);
      if (!stats) return;
      const buys5m = stats.buys5m ?? 0;
      const buys30m = stats.buys30m ?? 0;
      const buys1h = stats.buys1h ?? 0;
      const hotByBuys = HOT_LAUNCH_MIN_BUYS_FIRST_MIN > 0 && buys5m >= HOT_LAUNCH_MIN_BUYS_FIRST_MIN;
      const hotByHolders =
        HOT_LAUNCH_MIN_HOLDERS > 0 && stats.holderCount != null && stats.holderCount >= HOT_LAUNCH_MIN_HOLDERS;
      const iv1 = stats.indexerVol1h ?? 0;
      const iv24 = stats.indexerVol24h ?? 0;
      const hotByIndexerVol =
        HOT_LAUNCH_MIN_INDEXER_VOL_1H_USD > 0 && iv1 >= HOT_LAUNCH_MIN_INDEXER_VOL_1H_USD;
      const trendingByIndexerVol =
        TRENDING_MIN_INDEXER_VOL_24H_USD > 0 && iv24 >= TRENDING_MIN_INDEXER_VOL_24H_USD;
      const isHot = HOT_LAUNCH_ENABLED && (hotByBuys || hotByHolders || hotByIndexerVol);
      const isTrending =
        (TRENDING_MIN_BUYS_30M > 0 && buys30m >= TRENDING_MIN_BUYS_30M) ||
        (TRENDING_MIN_BUYS_5M > 0 && buys5m >= TRENDING_MIN_BUYS_5M) ||
        (TRENDING_MIN_BUYS_1H > 0 && buys1h >= TRENDING_MIN_BUYS_1H) ||
        trendingByIndexerVol;
      if (!isHot && !isTrending) return;
      // fetchLaunchByTokenAddress lives in notify.js; dynamic import avoids circular dep (notify → this module).
      const { fetchLaunchByTokenAddress } = await import("./notify.js");
      const fetched = (await fetchLaunchByTokenAddress(launch.tokenAddress, apiKey)) || launch;
      let launchForEmbed = {
        ...fetched,
        deployCount: launch.deployCount ?? fetched.deployCount,
        feeRecipientDeployCount: launch.feeRecipientDeployCount ?? fetched.feeRecipientDeployCount,
      };
      if (apiKey) launchForEmbed = await enrichLaunchWithBankrRoleCounts(launchForEmbed, { bankrApiKey: apiKey });
      const deployedMs =
        launchForEmbed.deployedAtMsFromBankr ?? stats.deployedAtMs ?? null;
      const mcFormatted = stats.marketCap != null ? formatUsd(stats.marketCap) : null;
      const deployedTelegram =
        deployedMs != null && Number.isFinite(deployedMs)
          ? new Date(deployedMs).toUTCString().replace(" GMT", " UTC")
          : null;
      const hotStats = {
        hotByBuys,
        hotByHolders,
        hotByIndexerVol,
        trendingByIndexerVol,
        buysFirstMin: buys5m,
        holderCount: stats.holderCount,
        isTrending,
        buys5m,
        buys30m,
        buys1h,
        marketCapFormatted: mcFormatted || null,
        deployedTelegram: deployedTelegram || null,
        indexerVol1h: iv1,
        indexerVol24h: iv24,
      };
      schedulePersonalHotTrendingDms(launchForEmbed, hotStats, { isHot, isTrending });
      await sendTelegramHotTrendingPings({
        sendTelegramHotPing,
        launchForEmbed,
        hotStats,
        isHot,
        isTrending,
        telegramChatIds,
        telegramHotTargets,
        telegramTrendingTargets,
        telegramDelayMs,
      });
    } catch (e) {
      console.error("Hot launch check (Telegram-only) failed:", e.message);
    }
  }, HOT_LAUNCH_DELAY_MS);
}
