/**
 * Per-token activity watch: compare Doppler-backed metrics to thresholds, post Discord alerts (cooldown).
 */

import { EmbedBuilder } from "discord.js";
import { fetchTokenActivityWatchMetrics } from "./token-trend-card.js";
import {
  getTenant,
  getActivityWatchList,
  touchActivityWatchAlert,
  listGuildIdsWithActivityWatches,
} from "./tenant-store.js";
import { formatUsd } from "./token-stats.js";

/** @param {import("./tenant-store.js").ActivityWatchEntry} entry */
export function summarizeActivityWatchThresholds(entry) {
  const parts = [];
  if (entry.mcapUsdMin != null) parts.push(`mcap≥$${fmtInt(entry.mcapUsdMin)}`);
  if (entry.minBuys15m != null) parts.push(`buys15m≥${entry.minBuys15m}`);
  if (entry.minSells15m != null) parts.push(`sells15m≥${entry.minSells15m}`);
  if (entry.minSwaps15m != null) parts.push(`swaps15m≥${entry.minSwaps15m}`);
  if (entry.minBuys1h != null) parts.push(`buys1h≥${entry.minBuys1h}`);
  if (entry.minSells1h != null) parts.push(`sells1h≥${entry.minSells1h}`);
  if (entry.minBuys24h != null) parts.push(`buys24h≥${entry.minBuys24h}`);
  if (entry.minSells24h != null) parts.push(`sells24h≥${entry.minSells24h}`);
  if (entry.minTrades24h != null) parts.push(`trades24h≥${entry.minTrades24h}`);
  return parts.length ? parts.join(" · ") : "(no thresholds)";
}

function fmtInt(n) {
  return Number(n).toLocaleString("en-US");
}

/**
 * @param {import("./tenant-store.js").ActivityWatchEntry} entry
 * @param {Awaited<ReturnType<typeof fetchTokenActivityWatchMetrics>>} m
 * @returns {string[]}
 */
export function evaluateActivityWatchConditions(entry, m) {
  if (!m) return [];
  const reasons = [];
  if (entry.mcapUsdMin != null && m.mcapUsd >= entry.mcapUsdMin) {
    reasons.push(`**MCap** ≥ ${formatUsd(entry.mcapUsdMin)} (now ${formatUsd(m.mcapUsd) ?? m.mcapUsd})`);
  }
  if (entry.minBuys15m != null && m.buys15m >= entry.minBuys15m) {
    reasons.push(`**Buys ~15m** ≥ ${entry.minBuys15m} (now ${m.buys15m})`);
  }
  if (entry.minSells15m != null && m.sells15m >= entry.minSells15m) {
    reasons.push(`**Sells ~15m** ≥ ${entry.minSells15m} (now ${m.sells15m})`);
  }
  if (entry.minSwaps15m != null && m.trades15m >= entry.minSwaps15m) {
    reasons.push(`**Swaps ~15m** ≥ ${entry.minSwaps15m} (now ${m.trades15m})`);
  }
  if (entry.minBuys1h != null && m.buys1h >= entry.minBuys1h) {
    reasons.push(`**Buys ~1h** ≥ ${entry.minBuys1h} (now ${m.buys1h})`);
  }
  if (entry.minSells1h != null && m.sells1h >= entry.minSells1h) {
    reasons.push(`**Sells ~1h** ≥ ${entry.minSells1h} (now ${m.sells1h})`);
  }
  if (entry.minBuys24h != null && m.buys24h >= entry.minBuys24h) {
    reasons.push(`**Buys 24h** ≥ ${entry.minBuys24h} (now ${m.buys24h})`);
  }
  if (entry.minSells24h != null && m.sells24h >= entry.minSells24h) {
    reasons.push(`**Sells 24h** ≥ ${entry.minSells24h} (now ${m.sells24h})`);
  }
  if (entry.minTrades24h != null && m.trades24h >= entry.minTrades24h) {
    reasons.push(`**Trades 24h** ≥ ${entry.minTrades24h} (now ${m.trades24h})`);
  }
  return reasons;
}

function metricsSnapshotLines(m) {
  return [
    `MCap: ${formatUsd(m.mcapUsd) ?? "—"} · Vol 1h/24h: ${formatUsd(m.vol1hUsd) ?? "—"} / ${formatUsd(m.vol24hUsd) ?? "—"}`,
    `~15m (sample): ${m.buys15m} buys · ${m.sells15m} sells · ${m.trades15m} swaps`,
    `~1h (sample): ${m.buys1h} buys · ${m.sells1h} sells`,
    `24h (indexer bucket / counts): ${m.buys24h} buys · ${m.sells24h} sells · ${m.trades24h} trades`,
    `Trend: ${m.trendLabel} (${m.trendScore}/100)`,
  ].join("\n");
}

/** Pick channel: watch → claim → alert. */
export function resolveActivityWatchChannelId(tenant) {
  if (!tenant) return null;
  return (
    tenant.watchAlertChannelId ||
    tenant.claimAlertChannelId ||
    tenant.alertChannelId ||
    tenant.allLaunchesChannelId ||
    null
  );
}

/**
 * @param {import("discord.js").Client} client
 */
export async function runActivityWatchPoll(client) {
  const guildIds = await listGuildIdsWithActivityWatches();
  for (const guildId of guildIds) {
    const tenant = await getTenant(guildId);
    const channelId = resolveActivityWatchChannelId(tenant);
    if (!channelId) continue;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) continue;

    const entries = await getActivityWatchList(guildId);
    const opts = {
      dopplerIndexerUrl: tenant.dopplerIndexerUrl || undefined,
    };

    for (const entry of entries) {
      if (!entry?.id || !entry.tokenAddress) continue;
      const now = Date.now();
      if (entry.lastAlertAtMs != null && now - entry.lastAlertAtMs < entry.cooldownSec * 1000) continue;

      let m;
      try {
        m = await fetchTokenActivityWatchMetrics(entry.tokenAddress, opts);
      } catch {
        continue;
      }
      if (!m) continue;

      const reasons = evaluateActivityWatchConditions(entry, m);
      if (reasons.length === 0) continue;

      const title = entry.label
        ? `📈 Activity watch: ${entry.label}`
        : `📈 Activity watch: ${m.label || entry.tokenAddress.slice(0, 10)}…`;
      const embed = new EmbedBuilder()
        .setColor(0x0052ff)
        .setTitle(title)
        .setDescription(
          `**${m.label || "Token"}** · \`${entry.tokenAddress}\`\n\n**Triggered:**\n${reasons.map((r) => `• ${r}`).join("\n")}`
        )
        .addFields({ name: "Snapshot", value: metricsSnapshotLines(m).slice(0, 1024) })
        .setURL(`https://bankr.bot/launches/${entry.tokenAddress}`)
        .setFooter({ text: `id: ${entry.id} · /activity-watch remove` });

      await channel.send({ embeds: [embed] }).catch(() => {});
      await touchActivityWatchAlert(guildId, entry.id, now);
    }
  }
}
