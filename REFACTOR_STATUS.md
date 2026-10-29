# REFACTOR_STATUS
Branch: refactor/harden-docker
Last Completed Step: 2.4
Next Immediate Step: 2.5 (user must run: npm install; then npm audit)
Blockers: classifier blocks "npm install" (overrides added to package.json, lockfile not yet updated)

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
- [ ] 2.5 dependabot / npm audit
## Phase 3
- [ ] 3.1 encryption at rest
- [ ] 3.2 auth/API hardening
- [ ] 3.3 curlParser audit
## Phase 4
- [ ] 4.1 find Cyrillic
- [ ] 4.2 translate
- [ ] 4.3 verify
## Phase 5
- [ ] 5.1 .dockerignore
- [ ] 5.2 Dockerfile
- [ ] 5.3 docker-compose.yml
- [ ] 5.4 docker-publish workflow
- [ ] 5.5 build + smoke test
- [ ] 5.6 README
- [ ] 5.7 final gate
