import { resolve } from 'node:path';
import { createApp, hostnameOf } from './app';
import { DEFAULT_SESSION_DAYS } from './auth';
import {
  allowsWeakSecrets,
  resolveSessionDays,
  validateConfig,
  validateConfigWarnings,
  validateFatalConfig,
} from './config';
import { installServerNetworking } from './net';
import { Store } from './store';
import { Tracker } from './tracker';
import { CpaTransport } from '../../src/services/cpa/CpaTransport';
import { CpaUsageProvider } from '../../src/services/cpa/CpaUsageProvider';
import { CpaSyncEngine } from './cpaSync';
import { CpaRoutingExecutor } from './cpaRouting';
import { resolveCpaConfig } from './config';

// Server-only SSRF guard: resolve hostnames and cap outbound response bodies.
installServerNetworking();

// Last line of defence: a rejected promise or a stray throw must be logged, never
// allowed to take the whole panel (and everyone's sessions) offline. Error objects
// carry stack traces and messages only; secrets are never part of them. The exit
// code is still set to 1 so a startup failure (nothing left keeping the event loop
// alive) ends the process with a failure status instead of a clean exit.
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
  process.exitCode = 1;
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  process.exitCode = 1;
});

const warnings = validateConfigWarnings(process.env);
for (const warning of warnings) console.warn(`[config] warning: ${warning}`);

const errors = validateConfig(process.env);
const fatal = validateFatalConfig(process.env);
if (fatal.length || (errors.length && !allowsWeakSecrets(process.env))) {
  console.error('Refusing to start: the configuration is unsafe.');
  for (const error of errors) console.error(`  - ${error}`);
  console.error('Generate strong values with: openssl rand -hex 32');
  if (fatal.length) {
    console.error('The problems listed above are fatal; ALLOW_WEAK_SECRETS=1 cannot override them.');
  } else {
    console.error('To start anyway, set ALLOW_WEAK_SECRETS=1 (not recommended).');
  }
  process.exit(1);
}
if (errors.length) {
  console.warn('[config] ALLOW_WEAK_SECRETS=1: STARTING WITH UNSAFE SECRETS - anyone who guesses them owns this panel.');
  for (const error of errors) console.warn(`[config] warning: ${error}`);
}

const PORT = Number(process.env.PORT) || 8795;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const APP_SECRET = process.env.APP_SECRET || '';
const API_TOKEN = process.env.API_TOKEN || '';
const SESSION_DAYS = resolveSessionDays(process.env, DEFAULT_SESSION_DAYS);
const DATA_DIR = resolve(process.env.DATA_DIR || 'data');
const WEB_DIR = resolve(process.env.WEB_DIR || 'public');
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

for (const host of ALLOWED_HOSTS) {
  if (!hostnameOf(host)) {
    console.error(`Refusing to start: ALLOWED_HOSTS entry ${JSON.stringify(host)} is not a valid hostname.`);
    process.exit(1);
  }
}

const store = new Store(DATA_DIR, 'tracker.db', APP_SECRET);
const tracker = new Tracker(store);

const cpaConfig = resolveCpaConfig(process.env);
let cpaSync: CpaSyncEngine | undefined;
let cpaRouting: CpaRoutingExecutor | undefined;

if (cpaConfig) {
  const cpaTransport = new CpaTransport({
    baseUrl: cpaConfig.baseUrl,
    managementKey: cpaConfig.managementKey,
    timeoutMs: cpaConfig.timeoutMs,
  });
  const cpaUsageProvider = new CpaUsageProvider(cpaTransport);
  tracker.setCpaProvider(cpaUsageProvider);
  cpaRouting = new CpaRoutingExecutor(store, cpaTransport);
  cpaSync = new CpaSyncEngine(
    store,
    tracker,
    cpaTransport,
    {
      syncIntervalSec: cpaConfig.pollIntervalSec,
    },
    cpaRouting
  );
}

const server = createApp(
  {
    adminPassword: ADMIN_PASSWORD,
    appSecret: APP_SECRET,
    apiToken: API_TOKEN,
    secureCookies: true,
    trustProxy: process.env.TRUST_PROXY === '1',
    webDir: WEB_DIR,
    sessionDays: SESSION_DAYS,
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    allowedHosts: ALLOWED_HOSTS,
    maxHeaderSize: 8192,
  },
  { store, tracker, cpaSync, cpaRouting }
);

// Explicit resource bounds: slow/malicious clients cannot hold sockets or headers forever.
server.headersTimeout = 15000;
server.requestTimeout = 30000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 50;
server.maxRequestsPerSocket = 1000;
server.maxConnections = 200;

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  const hard = setTimeout(() => {
    console.error('shutdown timed out after 10s, exiting');
    process.exit(1);
  }, 10000);
  hard.unref();
  tracker.stop();
  if (cpaSync) cpaSync.stop();
  server.close(() => {
    try {
      store.checkpoint();
      store.close();
    } catch (e) {
      console.error('shutdown: closing the database failed:', e);
    }
    clearTimeout(hard);
    process.exit(0);
  });
  // Keep-alive sockets would otherwise hold `close` open until they time out.
  server.closeIdleConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`AI Limits Tracker server on :${PORT} (data: ${DATA_DIR}, web: ${WEB_DIR})`);
  tracker.start();
  if (cpaSync) cpaSync.start();
});
