import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const site = path.join(root, 'site');
const html = readFileSync(path.join(site, 'mailbox.html'), 'utf8');

test('the mailbox page fits the site content security policy: no inline style or script, no external URL', () => {
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/i);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.doesNotMatch(html, /(?:src|href)="(?:https?:)?\/\//i);
});

test('every local file the mailbox page references exists', () => {
  for (const match of html.matchAll(/(?:src|href)="([^"#?]+)(?:[?#][^"]*)?"/g)) {
    const ref = match[1];
    if (/^[a-z]+:/i.test(ref) || ref === './') continue;
    // The server maps /LICENSE to the repository root, everything else to site/.
    assert.ok(existsSync(path.join(ref === 'LICENSE' ? root : site, ref)), `${ref} is referenced but missing`);
  }
});

test('the page says it is a static preview with invented data', () => {
  assert.match(html, /Static preview/);
  assert.match(html, /invented/);
});

test('sample addresses have the documented shape and the page never claims to be a running build', () => {
  const addresses = [...html.matchAll(/\bpp1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+/g)].map((m) => m[0]);
  assert.ok(addresses.length >= 4);
  for (const address of addresses) assert.equal(address.length, 113, address);
});

test('untrusted contact text is rendered as plain text, never as markup', () => {
  const messages = [...html.matchAll(/<pre class="msg-text">([\s\S]*?)<\/pre>/g)].map((m) => m[1]);
  assert.equal(messages.length, 3);
  for (const text of messages) assert.doesNotMatch(text, /[<>]/);
});
