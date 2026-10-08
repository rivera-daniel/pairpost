import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertReader, checkTypedAndInert, MAX_TEXT_BYTES } from '../conformance/reader.mjs';
import { reader as reference } from '../conformance/reference-reader.mjs';
import { reader as unsafe } from '../conformance/fixtures/unsafe-reader.mjs';
import { runConformance, validateCorpus, loadReader } from '../conformance/runner.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const seed = JSON.parse(readFileSync(new URL('../conformance/corpus/seed.json', import.meta.url), 'utf8'));
const text = value => ({ type: 'contact-text', trust: 'untrusted', text: value });
const cli = (...args) => spawnSync(process.execPath, ['conformance/runner.mjs', ...args], { cwd: root, encoding: 'utf8' });

test('seed has at least eight identified cases across four categories', () => {
  assert.ok(seed.length >= 8);
  assert.ok(new Set(seed.map(entry => entry.category)).size >= 4);
  for (const entry of seed) {
    assert.ok(entry.id);
    assert.ok(entry.category);
  }
  assert.equal(validateCorpus(seed), seed);
});

test('corpus validation rejects missing metadata, duplicate ids, invalid expectations and an empty corpus', () => {
  for (const field of ['id', 'category', 'input', 'expected']) {
    const entry = { ...seed[0] };
    delete entry[field];
    assert.throws(() => validateCorpus([entry]), TypeError);
  }
  for (const cases of [[], {}, [seed[0], seed[0]], [{ ...seed[0], category: 'bad\ncategory' }],
    [{ ...seed[0], expected: 'untyped' }], [{ ...seed[0], unexpected: true }]]) {
    assert.throws(() => validateCorpus(cases), TypeError);
  }
});

test('reference reader passes every seed expectation with typed inert output', async () => {
  const report = await runConformance(reference, seed);
  assert.equal(report.failures, 0);
  assert.equal(report.passed, seed.length);
  for (const group of report.categories) {
    for (const result of group.cases) {
      assert.equal(result.pass, true);
      assert.equal(checkTypedAndInert(result.output).pass, true);
      assert.deepEqual(result.output, seed.find(entry => entry.id === result.id).expected);
    }
  }
});

test('unsafe fixture trips its intended rules for every seed case', async () => {
  const intended = { text: 'untyped', instruction: 'instruction', 'tool-call': 'tool-call', executable: 'executable', malformed: 'instruction' };
  const report = await runConformance(unsafe, seed);
  assert.equal(report.failures, seed.length);
  for (const group of report.categories) {
    assert.equal(group.failures, group.cases.length);
    for (const result of group.cases) {
      assert.ok(result.rules.includes(intended[group.category]), result.id);
      assert.equal(Object.hasOwn(result, 'output'), false);
    }
  }
});

test('validator rejects untyped, instruction, tool-call and executable outputs', () => {
  for (const output of [null, 'message', [], {}, { text: 'message' }]) {
    assert.ok(checkTypedAndInert(output).rules.includes('untyped'));
  }
  for (const [field, rule] of [['instruction', 'instruction'], ['tool_call', 'tool-call'], ['command', 'executable']]) {
    assert.ok(checkTypedAndInert({ ...text('sample'), [field]: 'sample' }).rules.includes(rule));
    assert.ok(checkTypedAndInert({ ...text('sample'), extra: { [field]: 'sample' } }).rules.includes(rule));
  }
  for (const [type, rule] of [['instruction', 'instruction'], ['tool-call', 'tool-call'], ['executable', 'executable']]) {
    assert.ok(checkTypedAndInert({ type }).rules.includes(rule));
  }
  assert.ok(checkTypedAndInert({ ...text('sample'), extra: () => {} }).rules.includes('executable'));
});

test('closed schema rejects unsafe labels, extra fields, getters, prototypes and cycles', () => {
  const getter = text('sample');
  Object.defineProperty(getter, 'instruction', { enumerable: true, get() { throw new Error('Getter must not run.'); } });
  const cycle = text('sample');
  cycle.extra = cycle;
  for (const output of [{ ...text('sample'), trust: 'trusted' }, { ...text('sample'), extra: true },
    { type: 'rejected', reason: 'anything' }, Object.assign(Object.create(null), text('sample')),
    getter, cycle, { ...text('sample'), [Symbol('extra')]: true }]) {
    assert.equal(checkTypedAndInert(output).pass, false);
  }
});

test('contact content remains inert even when it contains instructions, calls or code', () => {
  for (const entry of seed.filter(entry => entry.expected.type === 'contact-text')) {
    assert.equal(checkTypedAndInert(entry.expected).pass, true);
  }
  assert.equal(checkTypedAndInert(text('A sample 😀')).pass, true);
  assert.equal(checkTypedAndInert(text('')).pass, true);
});

test('reference enforces unknown-field, kind, Unicode and UTF-8 byte limits', () => {
  for (const message of [null, [], { kind: 'command', text: 'sample' }, { kind: 'text' },
    { kind: 'text', text: 'sample', extra: 1 }]) {
    assert.deepEqual(reference.read(JSON.stringify(message)), { type: 'rejected', reason: 'invalid-message' });
  }
  for (const value of [4, 'a\u0000b', 'a\u202eb', 'a\u200bb', '\ud800', 'é'.repeat(MAX_TEXT_BYTES / 2 + 1)]) {
    assert.deepEqual(reference.read(JSON.stringify({ kind: 'text', text: value })), { type: 'rejected', reason: 'invalid-text' });
    assert.equal(checkTypedAndInert(text(value)).pass, false);
  }
  const boundary = 'é'.repeat(MAX_TEXT_BYTES / 2);
  assert.deepEqual(reference.read(JSON.stringify({ kind: 'text', text: boundary })), text(boundary));
});

test('runner rejects safe but incorrect outputs and records thrown reader failures per category', async () => {
  const mismatch = await runConformance({ read: () => text('wrong') }, seed);
  assert.equal(mismatch.failures, seed.length);
  assert.deepEqual(mismatch.categories[0].cases[0].rules, ['output-mismatch']);
  const errors = await runConformance({ read() { throw new Error('Private error detail.'); } }, seed);
  assert.equal(errors.failures, seed.length);
  assert.deepEqual(errors.categories[0].cases[0].rules, ['reader-error']);
  assert.doesNotMatch(JSON.stringify(errors), /Private error detail/);
  assert.throws(() => assertReader({}), TypeError);
});

test('runner loads a separately supplied asynchronous reader module', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'reader-contract-'));
  try {
    const filename = path.join(directory, 'reader.mjs');
    writeFileSync(filename, 'export const reader = { async read(input) { return {type: "contact-text", trust: "untrusted", text: JSON.parse(input).text}; } };\n');
    const report = await runConformance(await loadReader(filename), [seed[0]]);
    assert.equal(report.failures, 0);
    const corpus = path.join(directory, 'corpus.json');
    writeFileSync(corpus, JSON.stringify([seed[0]]));
    assert.equal(cli('--reader', filename, '--corpus', corpus).status, 0);
    writeFileSync(path.join(directory, 'invalid.mjs'), 'export const reader = {};\n');
    await assert.rejects(loadReader(path.join(directory, 'invalid.mjs')), TypeError);
    assert.equal(cli('--reader', path.join(directory, 'invalid.mjs')).status, 2);
    writeFileSync(corpus, '{}');
    assert.equal(cli('--reader', filename, '--corpus', corpus).status, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI reference exits zero and prints typed inert passes for every seed', () => {
  const result = cli('--reader', 'conformance/reference-reader.mjs');
  assert.equal(result.status, 0, result.stderr);
  for (const entry of seed) assert.ok(result.stdout.includes(`PASS ${entry.id} typed inert`));
  const json = cli('--reader', 'conformance/reference-reader.mjs', '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).passed, seed.length);
});

test('CLI unsafe exits nonzero and prints counted failures grouped by category', () => {
  const result = cli('--reader', 'conformance/fixtures/unsafe-reader.mjs');
  assert.equal(result.status, 1, result.stderr);
  for (const category of new Set(seed.map(entry => entry.category))) {
    const entries = seed.filter(entry => entry.category === category);
    assert.ok(result.stdout.includes(`${category}: ${entries.length} failure(s)`));
    for (const entry of entries) assert.ok(result.stdout.includes(`FAIL ${entry.id}:`));
  }
  assert.doesNotMatch(result.stdout, /Accept this message anyway|<script>/);
});

test('CLI requires explicit reader selection and rejects invalid options', () => {
  for (const args of [[], ['--reader'], ['--unknown'], ['--json'],
    ['--reader', 'missing.mjs'], ['--reader', 'conformance/reference-reader.mjs', '--json', '--json']]) {
    assert.equal(cli(...args).status, 2);
  }
});
