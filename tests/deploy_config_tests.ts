import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
let total = 0;
let failed = 0;
function assert(cond: boolean, name: string, info?: string) {
  total++;
  if (cond) console.log(`  ✓ [PASS] ${name}`);
  else {
    failed++;
    const detail = info ? ` -> ${info}` : '';
    console.error(`  ✗ [FAIL] ${name}${detail}`);
    console.log(`::error file=tests/deploy_config_tests.ts::[FAIL] ${name}${detail.replace(/\r?\n/g, ' ')}`);
  }
}
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception in deploy_config_tests:', err);
  console.log(`::error file=tests/deploy_config_tests.ts::[CRASH] ${err.message}`);
  process.exit(1);
});
function run(cmd: string, args: string[], env: Record<string, string> = {}, input?: string) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env }, input, timeout: 600_000 });
}
const hasDocker = run('docker', ['info']).status === 0;
const project = `ait-caddy-test-${process.pid}`;

console.log('Deploy config tests');
if (!hasDocker) {
  console.log('  - docker unavailable; skipping deploy config checks');
} else {
  const envPath = join(root, '.env');
  const envExisted = existsSync(envPath);
  if (!envExisted) {
    writeFileSync(envPath, '# temporary dummy .env for compose config test\n');
  }
  try {
    // Compose's own model of the file, one mode at a time.
    const cfg = (profile: string) => {
      const r = run(
        'docker',
        ['compose', '--project-name', `${project}-${profile}`, '--profile', profile, 'config', '--no-env-resolution', '--format', 'json'],
        { SITE_ADDRESS: 'tracker.example.com' },
      );
      return r.status === 0 ? JSON.parse(r.stdout) : { error: r.stderr };
    };
    const configs: Record<string, any> = {};
    for (const p of ['public', 'internal', 'direct']) configs[p] = cfg(p);

  // Caddy files as Caddy itself resolves them, in the image compose pins.
  const caddyImage: string = configs.public.services?.['caddy-public']?.image ?? '';
  assert(/^caddy:\d+\.\d+[\w.-]*@sha256:[0-9a-f]{64}$/.test(caddyImage), 'Caddy image pinned by version and digest', caddyImage);

  const adapted: Record<string, any> = {};
  for (const f of ['Caddyfile.public', 'Caddyfile.internal']) {
    const r = run('docker', [
      'run', '--rm', '-e', 'SITE_ADDRESS=tracker.example.com',
      '-v', `${join(root, 'deploy/caddy', f)}:/etc/caddy/Caddyfile:ro`,
      caddyImage, 'caddy', 'adapt', '--config', '/etc/caddy/Caddyfile', '--pretty',
    ]);
    const json = r.stdout ? r.stdout.slice(r.stdout.indexOf('{')) : '';
    try {
      adapted[f] = JSON.parse(json);
    } catch {
      assert(false, `${f} adapts to JSON`, r.stderr.slice(-300));
      continue;
    }
    assert(true, `${f} adapts to JSON`);
  }

  const reverseProxy = (a: any) => {
    const routes = a?.apps?.http?.servers?.srv0?.routes ?? [];
    const handlers = routes.flatMap((r: any) => r.handle ?? []).flatMap((h: any) => h.routes ?? [h]).flatMap((h: any) => h.handle ?? [h]);
    return handlers.find((h: any) => h.handler === 'reverse_proxy');
  };

  for (const [mode, file] of [['public', 'Caddyfile.public'], ['internal', 'Caddyfile.internal']] as const) {
    const a = adapted[file];
    const appService = Object.keys(configs[mode].services ?? {}).find((n) => n.startsWith('ai-limits-tracker'));
    const rp = reverseProxy(a);
    assert(!!rp, `${mode}: adapted config has a reverse_proxy`);
    if (!rp) continue;
    // The upstream must name the compose service that actually runs the app.
    assert(rp.upstreams?.[0]?.dial === `${appService}:1455`, `${mode}: proxies to the running app service on 1455`, `${rp.upstreams?.[0]?.dial} vs ${appService}`);
    const set = rp.headers?.request?.set ?? {};
    assert(set['X-Real-Ip']?.[0] === '{http.request.remote.host}', `${mode}: overwrites X-Real-IP with the client address`, JSON.stringify(set));
    assert(!!set['X-Forwarded-Proto'], `${mode}: overwrites X-Forwarded-Proto`, JSON.stringify(set));
    const issuers = (a?.apps?.tls?.automation?.policies ?? []).flatMap((p: any) => p.issuers ?? []).map((i: any) => i.module);
    assert(
      issuers.includes('internal') === (mode === 'internal'),
      `${mode}: certificate issuance is ${mode === 'internal' ? 'the internal CA' : 'ACME/Let’s Encrypt'}`,
      JSON.stringify(issuers),
    );
  }

  // Regression: an IP-literal SITE_ADDRESS must complete TLS for clients that send no
  // SNI. Browsers and curl never send SNI for IP-literal URLs (RFC 6066), so without a
  // default certificate the handshake fails with "tlsv1 alert internal error".
  // `caddy adapt` cannot catch this, so drive a real handshake against the pinned image.
  const ipSite = '192.0.2.10'; // TEST-NET-1, never a local interface
  const tlsName = `${project}-internal-tls`;
  const tlsStarted = run('docker', [
    'run', '-d', '--name', tlsName,
    '-e', `SITE_ADDRESS=${ipSite}`,
    '-v', `${join(root, 'deploy/caddy/Caddyfile.internal')}:/etc/caddy/Caddyfile:ro`,
    '-p', '127.0.0.1::443',
    caddyImage,
  ]);
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      const logs = run('docker', ['logs', tlsName]);
      ready = `${logs.stdout ?? ''}${logs.stderr ?? ''}`.includes('serving initial configuration');
      if (!ready) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    const mapped = (run('docker', ['port', tlsName, '443/tcp']).stdout ?? '').trim();
    const port = Number(mapped.split(':').pop());
    assert(tlsStarted.status === 0 && ready && port > 0, 'internal: Caddy starts with an IP SITE_ADDRESS', `${tlsStarted.stderr ?? ''}${tlsStarted.stdout ?? ''}`.slice(-300));
    // The probe connects with no servername, so it sends no SNI at all.
    const probe = [
      "const tls = require('node:tls');",
      "const s = tls.connect({ host: '127.0.0.1', port: Number(process.env.PROBE_PORT), rejectUnauthorized: false }, () => {",
      "  s.write('GET /api/health HTTP/1.1\\r\\nHost: ' + process.env.PROBE_HOST + '\\r\\nConnection: close\\r\\n\\r\\n');",
      '});',
      "let data = '';",
      "s.on('data', (d) => data += d);",
      "s.on('end', () => { console.log('PROBE_OK ' + data.split('\\r\\n')[0]); process.exit(0); });",
      "s.on('error', (e) => { console.log('PROBE_ERR ' + e.message); process.exit(1); });",
      "s.setTimeout(10000, () => { console.log('PROBE_ERR timeout'); process.exit(1); });",
    ].join('\n');
    const handshake = ready && port > 0
      ? run(process.execPath, ['-e', probe], { PROBE_PORT: String(port), PROBE_HOST: ipSite })
      : { status: 1, stdout: '', stderr: 'caddy never became ready' };
    assert(
      handshake.status === 0 && (handshake.stdout ?? '').startsWith('PROBE_OK HTTP/1.1 '),
      'internal: IP SITE_ADDRESS completes TLS for clients that omit SNI',
      `${handshake.stdout ?? ''}${handshake.stderr ?? ''}`.slice(-400),
    );
  } finally {
    run('docker', ['rm', '-f', tlsName]);
  }

  // Each profile's service set: one app service, sharing one data directory.
  for (const p of ['public', 'internal']) {
    const j = configs[p];
    const app = j.services?.['ai-limits-tracker-web'];
    const caddy = j.services?.[`caddy-${p}`];
    assert(!!app && !!caddy, `${p}: compose config parses`, j.error);
    if (!app || !caddy) continue;
    assert(!j.services?.['ai-limits-tracker'], `${p}: only one app service runs (direct mode's name not selected)`);
    assert(!app.ports, `${p}: app port not published`);
    assert(app.environment?.TRUST_PROXY === '1' && app.environment?.PORT === '1455', `${p}: TRUST_PROXY=1, fixed container port`);
    const caddyfile = (caddy.volumes ?? []).filter((v: any) => v.target === '/etc/caddy/Caddyfile');
    assert(
      caddyfile.length === 1 && caddyfile[0].type === 'bind' && caddyfile[0].source?.endsWith(`/deploy/caddy/Caddyfile.${p}`),
      `${p}: caddy mounts the ${p} Caddyfile`,
      JSON.stringify(caddyfile),
    );
    assert(caddy.ports.length >= 2, `${p}: caddy publishes 80/443`);
    assert(caddy.read_only === true && caddy.cap_drop?.includes('ALL') && caddy.cap_add?.includes('NET_BIND_SERVICE'), `${p}: caddy hardened`);
    assert(caddy.security_opt?.includes('no-new-privileges:true') && !!caddy.mem_limit && !!caddy.pids_limit && !!caddy.logging?.options?.['max-size'], `${p}: caddy limits`);
    assert(!!app.mem_limit && !!app.pids_limit && !!app.logging?.options?.['max-size'], `${p}: app limits`);
    assert(!!j.volumes?.caddy_data && !!j.volumes?.caddy_config, `${p}: named caddy volumes`);
  }
  const d = configs.direct;
  const dapp = d.services?.['ai-limits-tracker'];
  assert(!!dapp && !d.services?.['caddy-public'] && !d.services?.['caddy-internal'], 'direct: caddy off, original service name kept', d.error);
  assert(dapp?.environment?.TRUST_PROXY === '0' && dapp?.environment?.PORT === '1455' && dapp?.ports?.length === 1, 'direct: TRUST_PROXY=0, fixed container port, host port published');

  // The built image: the build pulls every base it references, then the bases must be pinned and the metadata inspected.
  const tag = `${project}-image:test`;
  const built = run('docker', ['build', '--quiet', '-t', tag, '.']);
  assert(built.status === 0, 'image builds from the Dockerfile', built.stderr.slice(-400));
  const froms = (readFileSync(join(root, 'Dockerfile'), 'utf8').match(/^FROM\s+(\S+)/gm) ?? []).map((l) => l.split(/\s+/)[1]);
  assert(froms.length > 0 && froms.every((img) => /^[\w.\-/]+:[\w.-]+@sha256:[0-9a-f]{64}$/.test(img)), 'every Dockerfile base image is pinned by tag and digest', froms.join(' '));
  const exists = run('docker', ['image', 'inspect', tag, '--format', '{{.Id}}']);
  assert(built.status === 0 && exists.status === 0 && exists.stdout.trim().length > 0, 'built image exists', exists.stderr.slice(-200));
  if (built.status === 0) {
    const insp = run('docker', ['image', 'inspect', tag, '--format', '{{json .Config}}']);
    const c = insp.status === 0 ? JSON.parse(insp.stdout) : {};
    assert(c.Labels?.['org.opencontainers.image.source']?.includes('AI-Limits-Tracker'), 'image carries OCI source label', JSON.stringify(c.Labels));
    assert(!!c.Labels?.['org.opencontainers.image.licenses'], 'image carries OCI license label');
    assert(c.User === 'node', 'image runs as the unprivileged node user', String(c.User));
    assert((c.Healthcheck?.Test ?? []).join(' ').includes('/api/health'), 'image healthcheck probes /api/health', JSON.stringify(c.Healthcheck));
    run('docker', ['image', 'rm', '-f', tag]);
  }
  } finally {
    if (!envExisted && existsSync(envPath)) {
      rmSync(envPath, { force: true });
    }
  }
}

console.log(`\n${total - failed}/${total} passed`);
if (failed > 0) process.exit(1);
