import { assertSafeUrl } from '../../src/services/http';

/**
 * Optional push channel: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to get
 * low-limit / reset / re-login alerts in Telegram. Without them alerts are
 * only kept in the in-app log.
 */
export async function notify(title: string, body: string): Promise<void> {
  // Alerts must never break a sync; sendTelegram never throws.
  await sendTelegram(title, body);
}

/** Sends one Telegram message and reports the outcome; never throws. */
export async function sendTelegram(title: string, body: string): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, error: 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set' };
  // Token must look like a Telegram bot token; keeps it from altering the URL path/host
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) return { ok: false, error: 'TELEGRAM_BOT_TOKEN is not a valid bot token' };
  try {
    const url = assertSafeUrl(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`);
    if (url.hostname !== 'api.telegram.org') return { ok: false, error: 'Unexpected Telegram host' };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `*${escapeMd(title)}*\n${escapeMd(body)}`, parse_mode: 'MarkdownV2' }),
      redirect: 'error',
      // A hung Telegram request must not pin a sync (and its socket) forever.
      signal: AbortSignal.timeout(10000),
    });
    return res.ok ? { ok: true } : { ok: false, error: `Telegram answered HTTP ${res.status}` };
  } catch {
    return { ok: false, error: 'Telegram could not be reached' };
  }
}

/** Escape MarkdownV2 special characters; the backslash itself must be escaped first. */
function escapeMd(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}
