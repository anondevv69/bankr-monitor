/**
 * Register slash commands in Telegram’s “/” menu via setMyCommands.
 * Separate lists for private DMs vs groups (Bot API scopes).
 */

/**
 * @param {string} botToken
 */
export async function registerTelegramBotCommands(botToken) {
  if (!botToken || typeof botToken !== "string") return;

  async function setCommands(commands, scope) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands, scope }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) {
        console.warn("[Telegram setMyCommands]", scope?.type, data.description || res.status);
      }
    } catch (e) {
      console.warn("[Telegram setMyCommands] fetch failed:", e.message);
    }
  }

  /** @type {{ command: string, description: string }[]} */
  const privateCommands = [
    { command: "start", description: "Personal alerts & command list" },
    { command: "help", description: "Same as /start" },
    { command: "activity", description: "Mcap & buy/sell thresholds (1 watch slot)" },
    { command: "add", description: "Add wallet, token, or keyword to watchlist" },
    { command: "remove", description: "Remove a watchlist item" },
    { command: "watchlist", description: "Show your watchlist" },
    { command: "alerts", description: "Show or toggle alert types" },
    { command: "settings", description: "Same as /alerts" },
    { command: "walletlookup", description: "Resolve X/Farcaster/URL → wallet" },
    { command: "wallet", description: "Same as /walletlookup" },
    { command: "lookup", description: "Bankr tokens for a wallet or profile" },
    { command: "token", description: "Fee summary for a Bankr token" },
  ];

  /** @type {{ command: string, description: string }[]} */
  const groupCommands = [
    { command: "start", description: "What works in this group" },
    { command: "claims", description: "Fee claims for a wallet — /claims 0x…" },
    { command: "topicid", description: "Show this chat/topic IDs for env vars" },
    { command: "tg_help", description: "Group commands & paste CA lookup" },
    { command: "walletlookup", description: "Resolve profile URL to wallet" },
    { command: "wallet", description: "Same as /walletlookup" },
    { command: "lookup", description: "Bankr tokens for wallet or profile" },
    { command: "token", description: "Fee summary for 0x…ba3" },
    { command: "tg_settings", description: "Paste lookup on/off status" },
    { command: "tg_tokenlookup", description: "Admins: on or off auto paste lookup" },
  ];

  await setCommands(privateCommands, { type: "all_private_chats" });
  await setCommands(groupCommands, { type: "all_group_chats" });
}
