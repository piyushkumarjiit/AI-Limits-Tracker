# REFACTOR_STATUS
Branch: refactor/harden-docker
Last Completed Step: 5.7 (all phases complete)
Next Immediate Step: none - open PR
Blockers: none

## Phase 1
- [x] 1.1 delete remote/agent files (done by user)
- [x] 1.2 remove imports/routes/UI/build refs (server/index.ts, store.ts agents table+methods, web/App.tsx, web/api.ts, scripts/build.mjs, package.json)
- [x] 1.3 typecheck + build:server + build:web
  - leftovers to review: AgentSession types in src/models/types.ts, unused agent/remote CSS in web/src/styles.css, README/integrations/README.md mentions, unused `notify`/`useCallback` imports
## Phase 2
- [x] 2.1 path traversal
- [x] 2.2 prototype pollution
- [x] 2.3 (assertSafeUrl in src/services/http.ts, used by isolatedFetch + notify) SSRF + escaping
- [x] 2.4 (semgrep.yml; pages.yml already had permissions) workflow permissions
- [x] 2.5 dependabot / npm audit
## Phase 3
- [x] 3.1 (scrypt key, v2 prefix, legacy auto-migrate) encryption at rest
- [x] 3.2 (security headers, hashed timing-safe compare, TRUST_PROXY gate for X-Real-IP) auth/API hardening
- [x] 3.3 (curlParser is regex-only, no exec/eval) curlParser audit
## Phase 4
- [x] 4.1 find Cyrillic
- [x] 4.2 translate
- [x] 4.3 (zero Cyrillic repo-wide; typecheck:all, 3 builds, 59/59 tests green) verify
## Phase 5
- [x] 5.1 .dockerignore
- [x] 5.2 Dockerfile
- [x] 5.3 docker-compose.yml
- [x] 5.4 docker-publish workflow
- [x] 5.5 build + smoke test
- [x] 5.6 README
- [x] 5.7 final gate
