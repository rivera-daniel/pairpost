import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
const guide = readme.slice(readme.indexOf('## Plugin guide'), readme.indexOf('## Contribute'));
const run = (...args) => spawnSync(process.execPath, ['conformance/runner.mjs', ...args], { cwd: root, encoding: 'utf8' });

test('the README example reader passes the seed and hostile corpora as written', () => {
  const example = /```js\n([\s\S]*?)```/.exec(guide)[1];
  assert.match(example, /from '\.\/conformance\/reader\.mjs'/);
  const dir = mkdtempSync(path.join(tmpdir(), 'readme-reader-'));
  try {
    const file = path.join(dir, 'my-reader.mjs');
    const readerUrl = pathToFileURL(path.join(root, 'conformance/reader.mjs')).href;
    writeFileSync(file, example.replace('./conformance/reader.mjs', readerUrl));
    for (const extra of [[], ['--corpus', 'conformance/corpus/hostile.json']]) {
      const result = run('--reader', file, ...extra);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /failures: 0/);
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('every command shown in the README guide runs the shipped runner with real files', () => {
  const commands = guide.match(/^node conformance\/runner\.mjs .*$/gm);
  assert.ok(commands.length >= 2);
  for (const command of commands) {
    for (const file of command.match(/\S+\.(?:mjs|json)\b/g).filter(name => name !== 'conformance/runner.mjs' && name !== 'my-reader.mjs')) {
      assert.doesNotThrow(() => readFileSync(path.join(root, file)), file);
    }
  }
});

test('the guide documents the exit codes and every rule name the runner can report', () => {
  for (const word of ['untyped', 'schema', 'instruction', 'tool-call', 'executable', 'output-mismatch', 'reader-error']) {
    assert.ok(guide.includes(`\`${word}\``), word);
  }
  assert.match(guide, /status is 0 .* 1 .* 2/);
});

test('the corpora table lists at least three https sources with no placeholders', () => {
  const urls = guide.slice(guide.indexOf('## Public corpora')).match(/https:\/\/[^\s|)]+/g);
  assert.ok(urls.length >= 3);
  for (const url of urls) assert.doesNotMatch(url, /example|placeholder|todo|xxx/i);
  assert.equal(new Set(urls).size, urls.length);
});
