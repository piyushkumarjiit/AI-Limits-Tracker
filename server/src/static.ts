import { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, normalize, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** True only if `target` resolves to a path strictly inside `base` (no null bytes). */
export function isInside(base: string, target: string): boolean {
  if (target.includes('\0')) return false;
  const b = resolve(base);
  return resolve(target).startsWith(b + sep);
}

export function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, webDir: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (decoded.includes('\0')) {
    res.writeHead(400).end('Bad request');
    return;
  }
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  let file = resolve(webDir, rel);
  if (!isInside(webDir, file) || !existsSync(file) || statSync(file).isDirectory()) {
    file = resolve(webDir, 'index.html'); // SPA fallback
  }
  if (!isInside(webDir, file) || !existsSync(file)) {
    res.writeHead(404).end('Not found');
    return;
  }
  const ext = extname(file);
  const immutable = /\.[0-9a-f]{8,}\./.test(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(readFileSync(file));
}
