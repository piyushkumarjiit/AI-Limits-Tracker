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
| `web/src/` | React panel with four pages (Overview, Accounts, Usage, Settings) and one account panel. `App.tsx` holds the shell and data loading, `route.ts` the hash routes (every drill-down filter lives in the URL), and `components/` one folder per page. Built to `web/dist`. |
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

The levels come from the routing policy (`policy.yaml`, or the built-in defaults in `src/constants/statusLevels.ts`): tight is the policy's `drainPct`, exhausted its `hardStopPct`, per account tier. The server reports each CLIProxy account's state from the routing engine, and the panel derives the shown state in `web/src/components/common/cpaUiUtils.ts` (`accountStatus`):

1. **Cooldown** when the routing service or an operator has taken the account out of the CLIProxy pool.
2. **Exhausted** at or below the hard stop (Pro 2%, Non-Pro 5% by default), or when the provider reports rate limiting, while the account is still in the pool.
3. **Tight** at or below the drain level (Pro 20%, Non-Pro 40% by default).
4. **Healthy** otherwise.

Every page uses this function so counts and labels agree. Telegram alerts and bar colours use the same levels.

## Known limitations

- The overview builds one row per provider family from FQD accounts and LiteLLM usage. Families that only appear in LiteLLM (API keys) have no quota window, so they show usage and spend instead of headroom.
- Alias-to-account shares use CLIProxy's last 24 hours; aliases that share a model share those numbers.
- `app.ts` routes requests with a long `if` chain and also contains a fallback overview builder used when the watermark service is not configured; both are candidates for splitting into route modules.
- Metric names keep the `alt_` prefix inherited from AI Limits Tracker for dashboard compatibility.
