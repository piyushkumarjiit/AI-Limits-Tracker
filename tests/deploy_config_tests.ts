import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
let total = 0;
let failed = 0;
function assert(cond: boolean, name: string, info?: string) {
  total++;
  if (cond) console.log(`  ✓ [PASS] ${name}`);
  else {
    failed++;
    console.error(`  ✗ [FAIL] ${name}${info ? ` -> ${info}` : ''}`);
  }
}
function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
}
const hasDocker = run('docker', ['compose', 'version']).status === 0;

console.log('Deploy config tests');
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
const froms = dockerfile.match(/^FROM .*$/gm) ?? [];
assert(froms.length === 2 && froms.every((l) => /@sha256:[0-9a-f]{64}/.test(l)), 'Dockerfile base images pinned by digest');
assert(/org\.opencontainers\.image\.source/.test(dockerfile), 'Dockerfile has OCI labels');
assert(/USER node/.test(dockerfile) && /HEALTHCHECK/.test(dockerfile), 'Dockerfile keeps runtime user and healthcheck');

const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
assert(/caddy:\d+\.\d+[\w.-]*@sha256:[0-9a-f]{64}/.test(compose), 'Caddy image pinned by version and digest');

for (const f of ['Caddyfile.public', 'Caddyfile.internal']) {
  const c = readFileSync(join(root, 'deploy/caddy', f), 'utf8');
  assert(/header_up X-Real-IP \{remote_host\}/.test(c), `${f} sets X-Real-IP`);
  assert(/header_up X-Forwarded-Proto \{scheme\}/.test(c), `${f} sets X-Forwarded-Proto`);
  assert(/tls internal/.test(c) === (f === 'Caddyfile.internal'), `${f} tls internal only in internal mode`);
}

if (!hasDocker) {
  console.log('  - docker compose unavailable; skipping compose config checks');
} else {
  const env = { SITE_ADDRESS: 'tracker.example.com', COMPOSE_PROJECT_NAME: 'ait-cfgtest' };
  const cfg = (profile: string) => {
    const r = run('docker', ['compose', '--env-file', '/dev/null', '--profile', profile, 'config', '--no-env-resolution', '--format', 'json'], env);
    return r.status === 0 ? JSON.parse(r.stdout) : { error: r.stderr };
  };
  for (const p of ['public', 'internal']) {
    const j = cfg(p);
    const app = j.services?.['ai-limits-tracker'];
    const caddy = j.services?.[`caddy-${p}`];
    assert(!!app && !!caddy, `${p}: compose config parses`, j.error);
    if (!app || !caddy) continue;
    assert(!app.ports, `${p}: app port not published`);
    assert(app.environment?.TRUST_PROXY === '1', `${p}: TRUST_PROXY=1`);
    assert(caddy.ports.length >= 2, `${p}: caddy publishes 80/443`);
    assert(caddy.read_only === true && caddy.cap_drop?.includes('ALL') && caddy.cap_add?.includes('NET_BIND_SERVICE'), `${p}: caddy hardened`);
    assert(caddy.security_opt?.includes('no-new-privileges:true') && !!caddy.mem_limit && !!caddy.pids_limit && !!caddy.logging?.options?.['max-size'], `${p}: caddy limits`);
    assert(!!app.mem_limit && !!app.pids_limit && !!app.logging?.options?.['max-size'], `${p}: app limits`);
    assert(!!j.volumes?.caddy_data && !!j.volumes?.caddy_config, `${p}: named caddy volumes`);
  }
  const d = cfg('direct');
  const dapp = d.services?.['ai-limits-tracker-direct'];
  assert(!!dapp && !d.services?.['caddy-public'] && !d.services?.['caddy-internal'], 'direct: caddy off', d.error);
  assert(dapp?.environment?.TRUST_PROXY === '0' && dapp?.ports?.length === 1, 'direct: TRUST_PROXY=0 and port published');

  for (const f of ['Caddyfile.public', 'Caddyfile.internal']) {
    const r = run(
      'docker',
      ['run', '--rm', '-e', 'SITE_ADDRESS=tracker.example.com', '-v', `${join(root, 'deploy/caddy', f)}:/etc/caddy/Caddyfile:ro`,
        'caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d',
        'caddy', 'validate', '--config', '/etc/caddy/Caddyfile'],
    );
    assert(r.status === 0, `${f} passes caddy validate`, r.stderr.slice(-300));
  }
}

console.log(`\n${total - failed}/${total} passed`);
if (failed > 0) process.exit(1);
