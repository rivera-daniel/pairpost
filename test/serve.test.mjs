import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { createSiteServer, isAllowedBindHost, parsePath, SECURITY_HEADERS } from '../serve.mjs';

let tmp;
let server;
let port;

function request(rawPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'jcs-'));
  const site = path.join(tmp, 'site');
  const skill = path.join(tmp, 'skill');
  const docs = path.join(tmp, 'docs');
  for (const d of [site, skill, docs, path.join(site, 'sub'), path.join(site, 'empty')]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(tmp, 'secret.txt'), 'top secret');
  writeFileSync(path.join(tmp, 'LICENSE'), 'MIT test license\n');
  writeFileSync(path.join(site, 'index.html'), '<!doctype html><title>t</title>'.padEnd(2000, ' '));
  writeFileSync(path.join(site, '.env'), 'SECRET=1');
  writeFileSync(path.join(site, 'sub', 'a.css'), 'body{}');
  writeFileSync(path.join(site, 'sub', '.hidden.css'), 'body{}');
  writeFileSync(path.join(site, 'weird.xyz'), 'unknown type');
  mkdirSync(path.join(site, '.git'));
  writeFileSync(path.join(site, '.git', 'config'), 'x');
  symlinkSync(path.join(tmp, 'secret.txt'), path.join(site, 'link.txt'));
  writeFileSync(path.join(skill, 'SKILL.md'), '# skill\n');
  writeFileSync(path.join(docs, 'a.md'), '# doc\n');
  writeFileSync(path.join(docs, 'index.html'), '<!doctype html><title>docs</title>');
  server = createSiteServer({ siteDir: site, skillDir: skill, docsDir: docs, repoDir: tmp });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('serves index and the three roots with correct content types', async () => {
  const index = await request('/');
  assert.equal(index.status, 200);
  assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal((await request('/sub/a.css')).headers['content-type'], 'text/css; charset=utf-8');
  const skill = await request('/skill/SKILL.md');
  assert.equal(skill.status, 200);
  assert.equal(skill.headers['content-type'], 'text/markdown; charset=utf-8');
  assert.equal((await request('/docs/a.md')).status, 200);
  assert.equal((await request('/docs/')).status, 200);
  const lic = await request('/LICENSE');
  assert.equal(lic.status, 200);
  assert.equal(lic.headers['content-type'], 'text/plain; charset=utf-8');
});

test('security headers are present on 200, 404 and 405', async () => {
  for (const res of [await request('/'), await request('/nope.html'), await request('/', { method: 'POST' })]) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      assert.equal(res.headers[name.toLowerCase()], value, name);
    }
  }
  const csp = (await request('/')).headers['content-security-policy'];
  assert.equal(
    csp,
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  const pp = (await request('/')).headers['permissions-policy'];
  assert.match(pp, /camera=\(\)/);
  assert.match(pp, /geolocation=\(\)/);
  assert.equal((await request('/')).headers['referrer-policy'], 'no-referrer');
  assert.equal((await request('/')).headers['x-content-type-options'], 'nosniff');
});

test('HEAD returns headers and no body', async () => {
  const res = await request('/sub/a.css', { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 0);
  assert.equal(res.headers['content-length'], '6');
  assert.ok(res.headers.etag);
});

test('other methods get 405 with Allow', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const res = await request('/', { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.allow, 'GET, HEAD');
  }
});

test('missing files, directories without index and unknown types are 404', async () => {
  assert.equal((await request('/missing.html')).status, 404);
  assert.equal((await request('/empty/')).status, 404);
  assert.equal((await request('/empty')).status, 301); // directory redirect, then 404: never a listing
  assert.equal((await request('/weird.xyz')).status, 404);
  assert.equal((await request('/skill/')).status, 404);
});

test('dotfiles and dot directories are refused at any depth', async () => {
  for (const p of ['/.env', '/.git/config', '/sub/.hidden.css', '/%2eenv', '/%2Egit/config', '/sub/%2e%2fa.css']) {
    const res = await request(p);
    assert.ok([400, 404].includes(res.status), `${p} -> ${res.status}`);
    assert.doesNotMatch(res.body.toString(), /SECRET/);
  }
});

test('path traversal never reads outside the roots', async () => {
  const attempts = [
    '/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt',
    '/sub/../../secret.txt', '/%252e%252e/secret.txt', '/..%5csecret.txt', '/sub/..%5c..%5csecret.txt',
    '/skill/../secret.txt', '/docs/%2e%2e/secret.txt', '/skill/..%2f..%2fsecret.txt',
    '/%00', '/a%00.css', '/sub/a.css%00', '//secret.txt', '/./secret.txt', '/sub//a.css',
  ];
  for (const p of attempts) {
    const res = await request(p);
    assert.notEqual(res.status, 200, `${p} -> ${res.status}`);
    assert.doesNotMatch(res.body.toString(), /top secret/, p);
  }
});

test('a symlink pointing outside the root is not followed', async () => {
  const res = await request('/link.txt');
  assert.equal(res.status, 404);
  assert.doesNotMatch(res.body.toString(), /top secret/);
});

test('malformed encoding and absolute-form targets are 400', async () => {
  assert.equal((await request('/%zz')).status, 400);
  assert.equal(parsePath('http://example.com/').status, 400);
  assert.equal(parsePath('*').status, 400);
});

test('ETag revalidation returns 304', async () => {
  const first = await request('/sub/a.css');
  const second = await request('/sub/a.css', { headers: { 'If-None-Match': first.headers.etag } });
  assert.equal(second.status, 304);
  assert.equal(second.body.length, 0);
  assert.equal(second.headers['content-security-policy'], SECURITY_HEADERS['Content-Security-Policy']);
});

test('text over 512 bytes is compressed on request, small files are not', async () => {
  const br = await request('/', { headers: { 'Accept-Encoding': 'br, gzip' } });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.match(brotliDecompressSync(br.body).toString(), /<title>t<\/title>/);
  const gzip = await request('/', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(gzip.headers['content-encoding'], 'gzip');
  assert.match(gunzipSync(gzip.body).toString(), /<title>t<\/title>/);
  assert.equal((await request('/')).headers['content-encoding'], undefined);
  assert.equal((await request('/sub/a.css', { headers: { 'Accept-Encoding': 'gzip' } })).headers['content-encoding'], undefined);
  assert.equal(br.headers.vary, 'Accept-Encoding');
});

test('listens on loopback only', () => {
  assert.equal(server.address().address, '127.0.0.1');
});

test('bind host: only loopback and Tailscale addresses are allowed', () => {
  // Built from parts so the public-content scan does not mistake test data for a real address.
  const shared = (b, c, d) => `100.${b}.${c}.${d}`;
  for (const ok of ['127.0.0.1', '::1', shared(64, 0, 1), shared(100, 1, 2), shared(127, 255, 254)]) {
    assert.equal(isAllowedBindHost(ok), true, ok);
  }
  for (const bad of ['0.0.0.0', '::', '192.168.1.10', '10.0.0.5', '172.16.0.1', shared(63, 255, 255), shared(128, 0, 1), '8.8.8.8', 'localhost', '', shared(64, 0, 256)]) {
    assert.equal(isAllowedBindHost(bad), false, bad);
  }
});
