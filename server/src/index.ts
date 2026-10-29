import { resolve } from 'node:path';
import { createApp } from './app';
import { DEFAULT_SESSION_DAYS } from './auth';
import { Store } from './store';
import { Tracker } from './tracker';

const PORT = Number(process.env.PORT) || 8795;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const APP_SECRET = process.env.APP_SECRET || '';
const API_TOKEN = process.env.API_TOKEN || '';
const DATA_DIR = resolve(process.env.DATA_DIR || 'data');
const WEB_DIR = resolve(process.env.WEB_DIR || 'public');

if (!ADMIN_PASSWORD || APP_SECRET.length < 16) {
  console.error('ADMIN_PASSWORD and APP_SECRET (16+ chars) must be set. See .env.example');
  process.exit(1);
}

const store = new Store(DATA_DIR, 'tracker.db', APP_SECRET);
const tracker = new Tracker(store);

const server = createApp(
  {
    adminPassword: ADMIN_PASSWORD,
    appSecret: APP_SECRET,
    apiToken: API_TOKEN,
    secureCookies: true,
    trustProxy: process.env.TRUST_PROXY === '1',
    webDir: WEB_DIR,
    sessionDays: DEFAULT_SESSION_DAYS,
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
  },
  { store, tracker }
);

server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`AI Limits Tracker server on :${PORT} (data: ${DATA_DIR}, web: ${WEB_DIR})`);
  tracker.start();
});
