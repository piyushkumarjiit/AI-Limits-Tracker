import { assertSafeUrl } from '../../src/services/http';

/**
 * Optional push channel: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to get
 * low-limit / reset / re-login alerts in Telegram. Without them alerts are
 * only kept in the in-app log.
 */
export async function notify(title: string, body: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  // Token must look like a Telegram bot token; keeps it from altering the URL path/host
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) return;
  try {
    const url = assertSafeUrl(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`);
    if (url.hostname !== 'api.telegram.org') return;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `*${escapeMd(title)}*\n${escapeMd(body)}`, parse_mode: 'MarkdownV2' }),
      redirect: 'error',
    });
  } catch {
    // Alerts must never break a sync
  }
}

/** Escape MarkdownV2 special characters; the backslash itself must be escaped first. */
function escapeMd(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}
