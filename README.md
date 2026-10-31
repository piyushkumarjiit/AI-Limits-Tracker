<div align="center">

<img src="web/public/icon.svg" width="88" height="88" alt="AI Limits Tracker" />

# AI Limits Tracker

**Track the usage limits of all your Claude, ChatGPT and Gemini accounts in one place — including several accounts of the same service.**

Mobile app · self-hosted web panel (PWA) · Chrome extension. Honest numbers, live reset timers, low-limit alerts. Your credentials never leave your own device or server.

<a href="https://github.com/piyushkumarjiit/AI-Limits-Tracker/stargazers"><img src="https://img.shields.io/github/stars/piyushkumarjiit/AI-Limits-Tracker?style=flat&color=1f9d74" alt="Stars" /></a>
<img src="https://img.shields.io/badge/license-MIT-black" alt="MIT" />
<img src="https://img.shields.io/badge/Claude%20·%20ChatGPT%20·%20Gemini-supported-e2683c" alt="Providers" />

</div>

---

## The problem

You have more than one AI subscription — maybe **two Claude accounts and two ChatGPT accounts** — and every existing tracker assumes one account per service. So you keep logging in and out just to check "how much of my 5-hour window is left on the *other* account?"

**AI Limits Tracker is built for the multi-account case from the ground up.** Every account is fully isolated: its own credentials, its own token refresh, its own history. Two Claude accounts show two different numbers, side by side.

## What you get

- 🔢 **All limits on one screen** — Claude (5-hour, weekly, Opus/Sonnet, extra spend), ChatGPT (Codex 5h & weekly, credits), Gemini (session & weekly), Antigravity (Gemini 5-hour & weekly, Claude/GPT, Argon).
- 👥 **Unlimited accounts per service** — two, three, ten Claude accounts? Each isolated, each refreshed in the background.
- ⏱ **Live reset countdowns** — "resets in 2h 14m", recalculated every tick.
- 📊 **Real statistics** — day streaks, limit hits, time spent in the red zone, burn-rate forecast ("will run out in 1h 40m"), busiest hours & weekdays, per-account comparison. All computed from real measurements — no invented message counts.
- 🔔 **Alerts** — at 20% / 10% / 0% remaining, on restore, and when a session needs re-login. Optional Telegram push on the server.
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
cp .env.example .env                 # set ADMIN_PASSWORD, APP_SECRET (openssl rand -hex 32) and SITE_ADDRESS
mkdir -p data && sudo chown 1000:1000 data   # the container runs as UID 1000 (node)

docker compose --profile public   up -d   # mode 1: public domain, Let's Encrypt
docker compose --profile internal up -d   # mode 2: LAN / LXC, Caddy internal CA
docker compose --profile direct   up -d   # mode 3: Caddy off, your own reverse proxy
```

You must pick one profile: a plain `docker compose up -d` starts nothing. Select it with `--profile`; `COMPOSE_PROFILES` in the environment is additive and must not be mixed with it (both modes would start and collide on host 80/443 and `./data`). Images build locally or are pulled from `ghcr.io/piyushkumarjiit/ai-limits-tracker:latest`.

Switching modes, or upgrading from the earlier single-service compose file: stop the old stack first with `docker compose --profile <old-mode> down` (or `docker compose down --remove-orphans` right after upgrading). Otherwise the previous mode's app container keeps running and polling alongside the new one, both writing `./data`, and a leftover Caddy container keeps host 80/443 so the new one fails with "port is already allocated".

#### Why HTTPS is required

The panel's login cookie is always marked `Secure`. Over plain `http://` on any address other than `localhost`, the browser silently drops it, so login cannot persist (and a non-Secure cookie would travel in clear text anyway). Any real Docker deployment therefore needs TLS in front of the app. The bundled [Caddy](https://caddyserver.com/) service provides it; its config is in [`deploy/caddy/`](deploy/caddy/).

In the two Caddy modes the app port is **not** published to the host: only Caddy publishes 80/443. Caddy sets `X-Real-IP` and `X-Forwarded-Proto`, and the app runs with `TRUST_PROXY=1` (forced by compose in those modes). Caddy's certificates and config live in the named volumes `caddy_data` and `caddy_config`. Set `ALLOWED_HOSTS` in `.env` to the same host as `SITE_ADDRESS` (hostname only, no port).

**Mode 1 — public domain (`--profile public`).** Point a DNS record at the host, make ports 80 and 443 reachable from the internet, then set `SITE_ADDRESS=tracker.example.com` and `ALLOWED_HOSTS=tracker.example.com`. Caddy obtains and renews a Let's Encrypt certificate automatically. Open `https://tracker.example.com`.

**Mode 2 — home LAN or LXC, no public domain (`--profile internal`).** Set `SITE_ADDRESS` to the LAN IP or local name (for example `192.168.1.20` or `tracker.lan`) and `ALLOWED_HOSTS` to the same. Caddy issues the certificate from its own internal CA (`tls internal`), so browsers warn until you trust the root certificate once per client device:

```bash
docker compose --profile internal cp caddy-internal:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```

Import `caddy-root.crt` into the device's trust store (Windows: *certmgr* → Trusted Root Certification Authorities; macOS: Keychain Access → System → Always Trust; Debian/Ubuntu: copy to `/usr/local/share/ca-certificates/` and run `sudo update-ca-certificates`; Firefox keeps its own store under Settings → Certificates). Keep `caddy_data` — it holds the CA key; recreating it issues a new root you must trust again.

**Mode 3 — Caddy off (`--profile direct`).** Starts only the app, published on `${PORT:-1455}` as before, with `TRUST_PROXY` taken from `.env` (default `0`). Put your own TLS-terminating reverse proxy in front; [`deploy/nginx.conf`](deploy/nginx.conf) is the systemd deployment's vhost, so for direct mode change its `proxy_pass` to the published port (`http://127.0.0.1:1455` by default). Set `TRUST_PROXY=1` only if your proxy sets `X-Real-IP`. Without HTTPS only `http://localhost` works. If you are coming from one of the Caddy modes, stop it first (`docker compose --profile <old-mode> down`) so it releases `./data` and host 80/443.

**Docker inside an LXC container.** The LXC needs nesting enabled on the host (Proxmox: Options → Features → *nesting*; or `lxc config set <name> security.nesting true`), otherwise Docker cannot start containers. Caddy binds 80/443 inside the Docker network namespace, so no extra LXC privileges are needed beyond that.

Host ports are configurable with `HTTP_PORT`, `HTTPS_PORT` (Caddy) and `PORT` (direct mode). In public mode leave `HTTP_PORT` and `HTTPS_PORT` at 80/443: Let's Encrypt validates and renews on those ports.

The image is a two-stage build: Expo/TypeScript tooling stays in the build stage, and the runtime image contains only the compiled server bundle (zero runtime dependencies) and the web panel. It runs as a non-root user with a read-only root filesystem, all capabilities dropped and `no-new-privileges`. Only `/app/data` is writable — that is where the SQLite database lives.

> If you do not create `data/` first, Docker creates it owned by root and the container cannot write to it. Run the `chown` line above, or point the volume at a directory your user owns.

**Offline / air-gapped transfer** — build once, then move the image:

```bash
# Direct mode: the app image alone.
docker save ghcr.io/piyushkumarjiit/ai-limits-tracker:latest | gzip > ai-limits-tracker.tar.gz

# Caddy modes (public/internal): pull the exact Caddy build compose pins if you only built the app,
# then save both. Copy this digest from the `image:` line in docker-compose.yml if it has changed.
docker pull caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
docker save ghcr.io/piyushkumarjiit/ai-limits-tracker:latest caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d | gzip > ai-limits-tracker.tar.gz

scp ai-limits-tracker.tar.gz user@node:/tmp/
# on the target node:
gunzip -c /tmp/ai-limits-tracker.tar.gz | docker load
docker compose --profile public up -d --no-build   # use --profile internal or direct instead as needed
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
- **Antigravity** — OAuth sign-in via Google (recommended) or paste a Google refresh token (`1//…`).

Paste it into **Add account**. For a second account of the same service, export from a second browser profile / incognito window.

> **Antigravity provider note:** Antigravity limits are read from Google's internal Cloud Code service using Antigravity's own sign-in client. This is unofficial. AI-Limits-Tracker only *reads* your quota every few minutes and never sends prompts, but Google could change or restrict this at any time.

## Security notes

- The server requires `ADMIN_PASSWORD` and `APP_SECRET`. Generate each with `openssl rand -hex 32`; the server refuses to start when either is missing or still an example placeholder, and rejects a short or predictable `APP_SECRET`.
- `API_TOKEN` is optional: a long-lived bearer token for scripts that cannot log in through the form.
- `SESSION_DAYS` sets the session cookie lifetime (default 30 days). `POST /api/sessions/revoke-all` ends every existing session at once.
- `ALLOWED_HOSTS` limits which `Host` headers are accepted. Set `TRUST_PROXY=1` when a reverse proxy sits in front so rate limiting sees real client IPs (the Caddy profiles do this for you).
- Run the panel behind HTTPS only — terminate TLS at a proxy in front of it — and do not expose it on a network you do not trust.
- The database directory is created with mode `0700` and the database files with `0600`; keep them owned by the user that runs the server.
- Client-facing errors are short and fixed; the exceptions behind them are logged on the server, never returned.
- Outbound requests are restricted to `https`, checked against private and reserved addresses (including redirects), and capped at 1 MB.
- Restarting the process clears the in-memory login throttle.

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
deploy/         systemd unit, nginx vhost, deploy script, Caddyfiles for the Docker profiles
```

Run the test suites (multi-account isolation, token refresh, parsing, honest statuses, the server's auth and HTTP security tests, and the Docker deploy-config checks — `npm run test:security` runs only the last two):

```bash
npm test
npm run typecheck:all
```

### What CI enforces

- **CI** (`.github/workflows/ci.yml`, on pull requests and pushes to `main`): `npm ci`, `npm run typecheck:all`, `npm test`, and `npm audit --omit=dev --audit-level=high` (fails on high/critical advisories). Superseded runs are cancelled.
- **Semgrep** scans every PR and push to `main`.
- **Image publish** (`docker-publish.yml`) runs the CI workflow first and only publishes if it passes. It builds and scans every published platform (`linux/amd64` and `linux/arm64`) with Trivy (fails on fixed HIGH/CRITICAL findings; unfixed ones are ignored), then pushes a multi-arch image, attaches build provenance and SBOM attestations, and signs it with keyless cosign. The scan skips the Node toolchain bundled with the `node:22-alpine` base image (`/usr/local/lib/node_modules/npm`, `/usr/local/lib/node_modules/corepack`, `/usr/local/lib/node_modules/yarn` and `/opt/yarn-v1.22.22`) because it is not part of the runtime application surface; application files under `/app` are still scanned. Updating the node base image is the real fix for those toolchain advisories and should be tracked separately.
- The Semgrep workflow runs independently on pull requests and pushes to `main`; it does not gate publishing.
- **Dependabot** opens weekly grouped updates for npm (root and `server`), GitHub Actions and Docker. Actions are pinned to commit SHAs.

## A note on account safety

This tool only **reads** your usage — it never generates anything, so it puts no load on your quota. It polls every few minutes (configurable). Using automated access to these services is a grey area under their terms; the risk is low but not zero. Keep the poll interval reasonable and secure the device that holds your tokens. You use it at your own responsibility.

## License

MIT © [Piyush Kumar](https://github.com/piyushkumarjiit) · based on the original [AI Limits Tracker](https://github.com/Rauan228/AI-Limits-Tracker) by Rauan

<div align="center"><sub>If this saved you a login dance, a ⭐ is appreciated.</sub></div>
