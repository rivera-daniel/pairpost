import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkTypedAndInert, MAX_TEXT_BYTES } from '../conformance/reader.mjs';
import { reader as reference } from '../conformance/reference-reader.mjs';
import { reader as unsafe } from '../conformance/fixtures/unsafe-reader.mjs';
import { runConformance, validateCorpus } from '../conformance/runner.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const load = name => JSON.parse(readFileSync(new URL(`../conformance/corpus/${name}.json`, import.meta.url), 'utf8'));
const hostile = load('hostile');
const seed = load('seed');
const categories = ['instruction-injection', 'role-confusion', 'hidden-text', 'link-exfiltration',
  'oversized-malformed', 'unicode-tricks', 'attachment-lures', 'replay'];
const cli = (...args) => spawnSync(process.execPath, ['conformance/runner.mjs', ...args], { cwd: root, encoding: 'utf8' });

test('hostile corpus is valid, has 40 or more cases and at least four in each of the eight categories', () => {
  assert.equal(validateCorpus(hostile), hostile);
  assert.ok(hostile.length >= 40);
  assert.deepEqual([...new Set(hostile.map(entry => entry.category))].sort(), [...categories].sort());
  for (const category of categories) {
    assert.ok(hostile.filter(entry => entry.category === category).length >= 4, category);
  }
});

test('case ids are unique across the seed and hostile corpora', () => {
  const ids = [...seed, ...hostile].map(entry => entry.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('the corpus file is plain ASCII so invisible characters are visible in review', () => {
  const raw = readFileSync(new URL('../conformance/corpus/hostile.json', import.meta.url), 'utf8');
  assert.doesNotMatch(raw, /[^\x20-\x7e\n]/);
});

test('expectations cover all three refusal reasons and inert pass-through', () => {
  const reasons = new Set(hostile.filter(entry => entry.expected.type === 'rejected').map(entry => entry.expected.reason));
  assert.deepEqual([...reasons].sort(), ['invalid-json', 'invalid-message', 'invalid-text']);
  assert.ok(hostile.some(entry => entry.expected.type === 'contact-text'));
});

test('size cases sit exactly on the UTF-8 byte limit', () => {
  const sizeOf = id => Buffer.byteLength(JSON.parse(hostile.find(entry => entry.id === id).input).text, 'utf8');
  assert.equal(sizeOf('om-limit-ascii'), MAX_TEXT_BYTES);
  assert.equal(sizeOf('om-limit-multibyte'), MAX_TEXT_BYTES);
  assert.equal(sizeOf('om-over-limit-ascii'), MAX_TEXT_BYTES + 1);
  assert.equal(sizeOf('om-over-limit-multibyte'), MAX_TEXT_BYTES + 2);
});

test('expected pass-through text is exactly the input text, with no normalisation', () => {
  for (const entry of hostile.filter(entry => entry.expected.type === 'contact-text')) {
    assert.equal(entry.expected.text, JSON.parse(entry.input).text, entry.id);
    assert.equal(checkTypedAndInert(entry.expected).pass, true, entry.id);
  }
});

test('reference reader passes every hostile case with typed inert output', async () => {
  const report = await runConformance(reference, hostile);
  assert.equal(report.failures, 0, JSON.stringify(report.categories.flatMap(group => group.cases.filter(result => !result.pass))));
  assert.equal(report.passed, hostile.length);
});

test('unsafe fixture fails every hostile case, so every category fails', async () => {
  const report = await runConformance(unsafe, hostile);
  assert.equal(report.failures, hostile.length);
  for (const group of report.categories) assert.equal(group.failures, group.cases.length, group.category);
});

test('reference refuses Unicode tag characters, which render as nothing but carry text', () => {
  for (const value of ['\u{e0001}', '\u{e0020}\u{e0041}', 'Hello\u{e007f}']) {
    assert.deepEqual(reference.read(JSON.stringify({ kind: 'text', text: value })), { type: 'rejected', reason: 'invalid-text' });
    assert.equal(checkTypedAndInert({ type: 'contact-text', trust: 'untrusted', text: value }).pass, false);
  }
  assert.equal(reference.read(JSON.stringify({ kind: 'text', text: 'A sample 😀' })).type, 'contact-text');
});

test('CLI runs the hostile corpus: reference exits 0, unsafe exits 1 with a count per category', () => {
  const pass = cli('--reader', 'conformance/reference-reader.mjs', '--corpus', 'conformance/corpus/hostile.json');
  assert.equal(pass.status, 0, pass.stdout);
  assert.match(pass.stdout, new RegExp(`Total: ${hostile.length}, passed: ${hostile.length}, failures: 0`));
  const fail = cli('--reader', 'conformance/fixtures/unsafe-reader.mjs', '--corpus', 'conformance/corpus/hostile.json');
  assert.equal(fail.status, 1);
  for (const category of categories) {
    const count = hostile.filter(entry => entry.category === category).length;
    assert.ok(fail.stdout.includes(`${category}: ${count} failure(s)`), category);
  }
});
