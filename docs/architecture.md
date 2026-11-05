# Architecture

FQD is a single Node.js (22 or 24) process that polls quota data, stores it in SQLite, serves a React panel and exposes JSON and Prometheus endpoints. The server bundle has no runtime dependencies.

```
                    ┌──────────────── FQD server (Node.js) ─────────────────┐
 Provider usage  ──▶│ tracker ──▶ store (node:sqlite, AES-GCM credentials)  │
 endpoints          │                 │                                     │
                    │ cpaSync ◀───────┤──▶ quotaCache ──▶ /api/quota        │
 CLIProxy mgmt API ◀┼▶ cpaWatermark*  │                └─▶ /metrics         │
 CLIProxy usage  ──▶│ cpaUsageCollector ──▶ telemetry ──▶ /api/telemetry   │
 LiteLLM activity──▶│ liteLlmUsage (src/services) ──▶ /api/usage            │
                    │ app.ts (HTTP, auth, CSRF) ──▶ static web/dist (React) │
                    └───────────────────────────────────────────────────────┘
```

## Directories

| Path | Contents |
| :--- | :--- |
| `src/` | Code shared by the server and the web panel: provider adapters (`services/providers`), OAuth flows, capacity math, CLIProxy transport and routing planner (`services/cpa`), formatters. No Node-only APIs. |
| `server/src/` | The server: HTTP app, auth, config validation, SQLite store, pollers, routing engines, metrics. Built to `server/dist/server.mjs`. |
| `web/src/` | React panel. `App.tsx` holds the shell and pages; `components/` holds the overview, drawer, radar, telemetry and settings components. Built to `web/dist`. |
| `tests/` | Plain `tsx` test scripts; `npm test` runs them all. `tests/vrt` holds visual-regression baselines for `npm run test:ui:vrt`. |
| `deploy/` | Caddy configs used by `docker-compose.yml`, plus a systemd unit and nginx example for bare-metal installs. |

## Server modules

| Module | Role |
| :--- | :--- |
| `index.ts` | Validates configuration, installs the outbound network guard, wires everything together. |
| `config.ts` | Environment parsing and startup checks; refuses weak or placeholder secrets. |
| `app.ts` | HTTP routing, sessions and bearer auth, CSRF, rate limiting, host allowlist. |
| `store.ts` | SQLite schema and access; encrypts stored credentials. Its key-derivation salts must never change. |
| `tracker.ts` | Polls each native account's provider on the refresh interval and records snapshots and history. |
| `cpaSync.ts` | Discovers credentials served by CLIProxy and links them to FQD accounts. |
| `cpaWatermarkPolicy.ts`, `cpaWatermarkEngine.ts`, `cpaTripwireEngine.ts`, `cpaWatermarkService.ts` | The routing policy: loads the optional YAML policy, evaluates per-account state (healthy, tight, exhausted, quarantined, airgapped), applies manual holds and, in `enforce` mode, writes weights and disabled flags to CLIProxy. |
| `cpaUsageCollector.ts`, `telemetry.ts` | Read-only request and token telemetry from CLIProxy's usage queue. |
| `src/services/liteLlmUsage.ts` | LiteLLM usage for `/api/usage`: reads the aggregated daily activity and the alias map (`/model/info`), groups by alias and provider family, and joins aliases to CLIProxy accounts on the model name. Needs an admin-read key. |
| `quotaCache.ts`, `metrics.ts` | Build the `/api/quota` view and Prometheus text with ETags. |
| `notify.ts` | In-app alert log and optional Telegram delivery. |
| `net.ts` | Outbound guard: resolves hostnames and refuses private or reserved addresses for provider calls; caps response size. |

## Account states

The panel derives one of four states per account in `web/src/components/common/cpaUiUtils.ts` (`accountStatus`):

1. **Cooldown** when the routing service or an operator has taken the account out of the CLIProxy pool.
2. **Exhausted** when the tightest window is at 0% or the provider reports rate limiting while the account is still in the pool.
3. **Tight** at 35% or below.
4. **Healthy** otherwise.

Every page uses this function so counts and labels agree.

## Known limitations

- The overview builds one row per provider family from FQD accounts and LiteLLM usage. Families that only appear in LiteLLM (API keys) have no quota window, so they show usage and spend instead of headroom.
- Alias-to-account shares use CLIProxy's last 24 hours; aliases that share a model share those numbers.
- `app.ts` routes requests with a long `if` chain and also contains a fallback overview builder used when the watermark service is not configured; both are candidates for splitting into route modules.
- `App.tsx` and `ui.tsx` are large single files; new UI should go into `web/src/components/`.
- Metric names keep the `alt_` prefix inherited from AI Limits Tracker for dashboard compatibility.
