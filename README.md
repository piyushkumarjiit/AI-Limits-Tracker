<div align="center">

<img src="web/public/icon.svg" width="88" height="88" alt="AI Limits Tracker" />

# AI Limits Tracker

**Track the usage limits of all your Claude, ChatGPT and Gemini accounts in one place — including several accounts of the same service.**

Mobile app · self-hosted web panel (PWA) · Chrome extension. Honest numbers, live reset timers, low-limit alerts. Your credentials never leave your own device or server.

<a href="https://github.com/piyushkumarjiit/AI-Limits-Tracker/stargazers"><img src="https://img.shields.io/github/stars/Rauan228/AI-Limits-Tracker?style=flat&color=1f9d74" alt="Stars" /></a>
<img src="https://img.shields.io/badge/license-MIT-black" alt="MIT" />
<img src="https://img.shields.io/badge/Claude%20·%20ChatGPT%20·%20Gemini-supported-e2683c" alt="Providers" />

</div>

---

## The problem

You have more than one AI subscription — maybe **two Claude accounts and two ChatGPT accounts** — and every existing tracker assumes one account per service. So you keep logging in and out just to check "how much of my 5-hour window is left on the *other* account?"

**AI Limits Tracker is built for the multi-account case from the ground up.** Every account is fully isolated: its own credentials, its own token refresh, its own history. Two Claude accounts show two different numbers, side by side.

## What you get

- 🔢 **All limits on one screen** — Claude (5-hour, weekly, Opus/Sonnet, extra spend), ChatGPT (Codex 5h & weekly, credits), Gemini (session & weekly).
- 👥 **Unlimited accounts per service** — two, three, ten Claude accounts? Each isolated, each refreshed in the background.
- ⏱ **Live reset countdowns** — "resets in 2h 14m", recalculated every tick.
- 📊 **Real statistics** — day streaks, limit hits, time spent in the red zone, burn-rate forecast ("will run out in 1h 40m"), busiest hours & weekdays, per-account comparison. All computed from real measurements — no invented message counts.
- 🔔 **Alerts** — at 20% / 10% / 0% remaining, on restore, and when a session needs re-login. Optional Telegram push on the server.
- **Remote Codex chat** — send tasks from the web panel on your phone, stream replies, stop work and handle approvals on your own laptop. One-time pairing, separate control authorization and locally selected projects. [Setup](integrations/CODEX-REMOTE.md).
- 🔒 **Private by design** — tokens live only on your device (Keychain/Keystore) or your own server (AES-256-GCM encrypted). Requests go straight to Anthropic / OpenAI / Google. No third-party backend, ever.

## Three ways to use it

| | Best for | Accounts |
|---|---|---|
| 📱 **Mobile app** (Expo / React Native) | Personal daily driver on your phone | Unlimited, isolated |
| 🖥 **Web panel** (self-hosted PWA) | Check from anywhere, install to home screen, 24/7 background polling | Unlimited, isolated |
| 🧩 **Chrome extension** | A glance from the toolbar while you work | One per browser profile |

---

## Web panel — `#web-panel`

A single Node file (**zero runtime dependencies**, Node 22+) that polls your accounts around the clock, stores encrypted history, serves a password-protected PWA, and can push alerts to Telegram. Install it to your phone's home screen and it behaves like a native app.

```bash
git clone https://github.com/piyushkumarjiit/AI-Limits-Tracker.git
cd AI-Limits-Tracker
npm install
npm run build:server && npm run build:web

cp .env.example .env                 # set ADMIN_PASSWORD and APP_SECRET
WEB_DIR=web/dist DATA_DIR=./data node server/dist/server.mjs
# open http://localhost:8795
```

### Run with Docker (recommended)

```bash
git clone https://github.com/piyushkumarjiit/AI-Limits-Tracker.git
cd AI-Limits-Tracker
cp .env.example .env                 # set ADMIN_PASSWORD and APP_SECRET (openssl rand -hex 32)
mkdir -p data && sudo chown 1000:1000 data   # the container runs as UID 1000 (node)

docker compose up -d                 # builds locally, or pulls ghcr.io/piyushkumarjiit/ai-limits-tracker:latest
# open http://localhost:1455
```

The image is a two-stage build: Expo/TypeScript tooling stays in the build stage, and the runtime image contains only the compiled server bundle (zero runtime dependencies) and the web panel. It runs as a non-root user with a read-only root filesystem, all capabilities dropped and `no-new-privileges`. Only `/app/data` is writable — that is where the SQLite database lives.

> If you do not create `data/` first, Docker creates it owned by root and the container cannot write to it. Run the `chown` line above, or point the volume at a directory your user owns.

**Offline / air-gapped transfer** — build once, then move the image:

```bash
docker save ai-limits-tracker:latest | gzip > ai-limits-tracker.tar.gz
scp ai-limits-tracker.tar.gz user@node:/tmp/
# on the target node:
gunzip -c /tmp/ai-limits-tracker.tar.gz | docker load
docker compose up -d --no-build
```

Images are published for `linux/amd64` and `linux/arm64` by [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml) on every push to `main` and on `v*` tags.

**Deploy to a VPS with systemd + nginx instead** — systemd unit, nginx vhost and a one-shot script are in [`deploy/`](deploy/). When a reverse proxy sits in front of the app, set `TRUST_PROXY=1` so rate limiting uses the real client IP:

```bash
npm run build:server && npm run build:web
scp -r server/dist web/dist deploy  user@your-host:/opt/ai-limits-tracker/
# on the host:
DOMAIN=limits.example.com bash /opt/ai-limits-tracker/deploy/deploy.sh
```

### Connecting an account (web / server)

The server reads your limits using a session you export from your browser — no passwords, no impersonating other apps:

- **Claude** — `claude.ai` → DevTools → Application → Cookies → copy `sessionKey`, or *Copy as cURL* on any `/api` request.
- **ChatGPT** — `chatgpt.com` → DevTools → Network → *Copy as cURL* on a `backend-api` request.
- **Gemini** — `gemini.google.com` → Network → *Copy as cURL* on a `batchexecute` request (one browser profile per Google account).

Paste it into **Add account**. For a second account of the same service, export from a second browser profile / incognito window.

## Mobile app

```bash
npm install
npm start        # Expo — scan the QR with Expo Go, or press a / i
```

Built with Expo Router, SQLite, SecureStore and `react-native-svg`. The phone polls your accounts while the app is open and when it returns to the foreground.

## Chrome extension

```bash
npm run build:extension
# chrome://extensions → Developer mode → Load unpacked → select extension/dist
```

Reads limits through the browser's **own logged-in session** on claude.ai / chatgpt.com — it never signs in for you. One account per service per Chrome profile; use a second profile for a second account. A badge on the toolbar icon shows the lowest remaining %.

---

## How the numbers are honest

No AI subscription exposes a message or token counter, so this app never invents one. It reads the **percentage of each rate-limit window** the service itself reports, and everything else — streaks, forecasts, charts — is derived from how that percentage changes over time. When a service returns no number, you see *"no data"*, not a fake 0%. When a refresh fails, the last real numbers stay, marked as stale.

## Architecture

```
src/            shared TypeScript — providers, parsing, stats (used by all 3 apps)
src/app/        mobile app screens (Expo Router)
server/         self-hosted Node server + API  (server/src)
web/            web panel — React PWA           (web/src)
extension/      Chrome MV3 extension            (extension/src)
deploy/         systemd unit, nginx vhost, deploy script
```

Run the test suite (44 tests — multi-account isolation, token refresh, parsing, honest statuses):

```bash
npm test
npm run typecheck:all
```

## A note on account safety

This tool only **reads** your usage — it never generates anything, so it puts no load on your quota. It polls every few minutes (configurable). Using automated access to these services is a grey area under their terms; the risk is low but not zero. Keep the poll interval reasonable and secure the device that holds your tokens. You use it at your own responsibility.

## License

MIT © [Rauan](https://github.com/Rauan228)

<div align="center"><sub>If this saved you a login dance, a ⭐ is appreciated.</sub></div>
