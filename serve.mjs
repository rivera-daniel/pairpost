#!/usr/bin/env node
// Static file server for the Pairpost site. Zero dependencies, Node 22.
//
//   node serve.mjs
//
// Binds to 127.0.0.1 by default. The port comes from PAIRPOST_SITE_PORT (default 5190).
// PAIRPOST_SITE_HOST may name one other address, but only a loopback address or a
// Tailscale address (100.64.0.0/10): the page is never offered on a LAN or the internet.
// Serves three roots: site/ at /, skill/ at /skill/, docs/ at /docs/, plus /LICENSE.
// GET and HEAD only. No directory listings. Dotfiles and traversal are refused.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { brotliCompress, gzip, constants as zc } from 'node:zlib';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 5190;
export const HOST = '127.0.0.1';

/** True for a loopback address or an address in the Tailscale range 100.64.0.0/10. */
export function isAllowedBindHost(host) {
  if (host === '127.0.0.1' || host === '::1') return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return false;
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.md', '.txt', '.svg']);
const LONG_CACHE = new Set(['.woff2', '.svg', '.png', '.ico']);

export const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // Everything denied except writing to the clipboard from this origin, which the copy buttons use.
  'Permissions-Policy': [
    'accelerometer=()', 'autoplay=()', 'camera=()', 'display-capture=()', 'fullscreen=()',
    'geolocation=()', 'gyroscope=()', 'hid=()', 'magnetometer=()', 'microphone=()', 'midi=()',
    'payment=()', 'publickey-credentials-get=()', 'serial=()', 'usb=()', 'xr-spatial-tracking=()',
    'clipboard-read=()', 'clipboard-write=(self)',
  ].join(', '),
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

/**
 * Map a URL path to a root directory and a relative path inside it.
 * Returns null when the path is not under a served prefix.
 */
function route(roots, pathname) {
  if (pathname === '/LICENSE') return { root: roots.repo, rel: 'LICENSE', file: true };
  for (const prefix of ['/skill', '/docs']) {
    if (pathname === prefix) return { redirect: `${prefix}/` };
    if (pathname.startsWith(`${prefix}/`)) {
      return { root: roots[prefix.slice(1)], rel: pathname.slice(prefix.length + 1) };
    }
  }
  return { root: roots.site, rel: pathname.slice(1) };
}

/**
 * Validate and decode a raw request path. Returns { pathname } or { status }.
 * Decodes exactly once. Refuses NUL, backslashes, empty or dot segments.
 */
export function parsePath(rawTarget) {
  if (typeof rawTarget !== 'string' || !rawTarget.startsWith('/') || rawTarget.startsWith('//')) {
    return { status: 400 };
  }
  const rawPath = rawTarget.split('?', 1)[0].split('#', 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { status: 400 };
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return { status: 400 };
  const segments = decoded.split('/').slice(1);
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const last = i === segments.length - 1;
    if (seg === '') {
      if (last) continue; // trailing slash
      return { status: 400 }; // "//" inside a path
    }
    if (seg.startsWith('.')) return { status: 404 }; // dotfiles, dot segments
  }
  return { pathname: decoded };
}

async function resolveFile(rootDir, rel) {
  const rootReal = await fs.realpath(rootDir);
  const candidate = path.resolve(rootReal, rel);
  if (candidate !== rootReal && !candidate.startsWith(rootReal + path.sep)) return { status: 400 };
  let real;
  try {
    real = await fs.realpath(candidate);
  } catch {
    return { status: 404 };
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return { status: 404 };
  const stat = await fs.stat(real);
  return { real, stat };
}

const encCache = new Map(); // key: etag + encoding
function pickEncoding(acceptEncoding) {
  const accepted = String(acceptEncoding || '').toLowerCase();
  if (/\bbr\b/.test(accepted)) return 'br';
  if (/\bgzip\b/.test(accepted)) return 'gzip';
  return null;
}

async function compress(enc, body, etag) {
  const key = `${etag}|${enc}`;
  let out = encCache.get(key);
  if (!out) {
    out = enc === 'br'
      ? await brotli(body, { params: { [zc.BROTLI_PARAM_QUALITY]: 6 } })
      : await gz(body, { level: 6 });
    if (encCache.size > 256) encCache.clear();
    encCache.set(key, out);
  }
  return out;
}

function send(res, status, headers, body, head) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(head ? undefined : body);
}

function plain(res, status, head, extra = {}) {
  const text = `${status} ${status === 404 ? 'Not Found' : status === 405 ? 'Method Not Allowed' : 'Bad Request'}\n`;
  send(res, status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...extra,
  }, text, head);
}

export function createSiteServer({
  siteDir = path.join(HERE, 'site'),
  skillDir = path.join(HERE, 'skill'),
  docsDir = path.join(HERE, 'docs'),
  repoDir = HERE,
  log = () => {},
} = {}) {
  const roots = { site: siteDir, skill: skillDir, docs: docsDir, repo: repoDir };

  const server = createServer(async (req, res) => {
    const head = req.method === 'HEAD';
    try {
      if (req.method !== 'GET' && !head) {
        plain(res, 405, false, { Allow: 'GET, HEAD' });
        return;
      }
      const parsed = parsePath(req.url);
      if (parsed.status) {
        plain(res, parsed.status, head);
        return;
      }
      const target = route(roots, parsed.pathname);
      if (target.redirect) {
        send(res, 301, { Location: target.redirect, 'Content-Length': 0 }, undefined, head);
        return;
      }
      let rel = target.rel;
      if (!target.file && (rel === '' || rel.endsWith('/'))) rel += 'index.html';
      let found = await resolveFile(target.root, rel);
      if (!found.status && found.stat.isDirectory()) {
        send(res, 301, { Location: `${parsed.pathname}/`, 'Content-Length': 0 }, undefined, head);
        return;
      }
      if (found.status || !found.stat.isFile()) {
        plain(res, found.status || 404, head);
        return;
      }

      const ext = target.rel === 'LICENSE' ? '.txt' : path.extname(found.real).toLowerCase();
      const type = TYPES[ext];
      if (!type) {
        plain(res, 404, head);
        return;
      }
      const etag = `"${createHash('sha1').update(`${found.stat.size}:${found.stat.mtimeMs}:${found.real}`).digest('base64url')}"`;
      const cache = LONG_CACHE.has(ext) ? 'public, max-age=86400' : 'no-cache';
      const base = { 'Content-Type': type, ETag: etag, 'Cache-Control': cache, Vary: 'Accept-Encoding' };

      if (req.headers['if-none-match'] === etag) {
        send(res, 304, base, undefined, true);
        return;
      }

      let body = await fs.readFile(found.real);
      const enc = COMPRESSIBLE.has(ext) && body.length > 512 ? pickEncoding(req.headers['accept-encoding']) : null;
      const headers = { ...base };
      if (enc) {
        body = await compress(enc, body, etag);
        headers['Content-Encoding'] = enc;
      }
      headers['Content-Length'] = body.length;
      send(res, 200, headers, body, head);
    } catch (error) {
      log(`error ${req.method} ${req.url}: ${error?.message ?? error}`);
      if (!res.headersSent) plain(res, 400, head);
      else res.destroy();
    }
  });

  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  server.on('request', (req, res) => {
    res.on('finish', () => log(`${req.method} ${String(req.url).split('?')[0]} ${res.statusCode}`));
  });
  return server;
}

function readPort() {
  const raw = process.env.PAIRPOST_SITE_PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`PAIRPOST_SITE_PORT must be an integer from 1 to 65535, got "${raw}"`);
    process.exit(2);
  }
  return port;
}

function readHost() {
  const raw = process.env.PAIRPOST_SITE_HOST;
  if (raw === undefined || raw === '') return HOST;
  if (!isAllowedBindHost(raw)) {
    console.error(`PAIRPOST_SITE_HOST must be a loopback or a Tailscale (100.64.0.0/10) address, got "${raw}"`);
    process.exit(2);
  }
  return raw;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = readPort();
  const host = readHost();
  const server = createSiteServer({ log: (line) => console.log(line) });
  server.listen(port, host, () => console.log(`pairpost-site listening on http://${host}:${port}/`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
