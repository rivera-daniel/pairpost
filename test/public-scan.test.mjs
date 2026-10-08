import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('public scan accepts public ranges and exact test literals while rejecting other private addresses', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'public-scan-'));
  try {
    mkdirSync(path.join(directory, 'scripts'));
    mkdirSync(path.join(directory, 'test'));
    copyFileSync(new URL('../scripts/check-public.sh', import.meta.url), path.join(directory, 'scripts/check-public.sh'));
    const git = spawnSync('git', ['init', '--quiet', directory], { encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
    const emptyList = path.join(directory, 'private-denylist.txt');
    writeFileSync(emptyList, '');
    const scan = () => spawnSync('bash', ['scripts/check-public.sh'], { cwd: directory, encoding: 'utf8', env: { ...process.env, PAIRPOST_PRIVATE_DENYLIST: emptyList } });
    const range = [100, 64, 0, 0].join('.') + '/10';
    const example = [100, 64, 0, 1].join('.');
    const privateAddress = [100, 70, 1, 2].join('.');
    const documentation = path.join(directory, 'sample.md');
    const fixture = path.join(directory, 'test/serve.test.mjs');
    writeFileSync(documentation, `Public range: ${range}\n`);
    writeFileSync(fixture, `const synthetic = '${example}';\n`);
    assert.equal(scan().status, 0);
    for (const content of [example, privateAddress, `${range} ${privateAddress}`, `${range}0`]) {
      writeFileSync(documentation, `${content}\n`);
      assert.equal(scan().status, 1, content);
    }
    writeFileSync(documentation, `${range}\n`);
    writeFileSync(fixture, `const addresses = ['${example}', '${privateAddress}'];\n`);
    assert.equal(scan().status, 1);
    writeFileSync(fixture, `const synthetic = '${example}';\n`);
    writeFileSync(path.join(directory, 'sample.bin'), Buffer.from([0, 1, 2, 3]));
    const binaryScan = scan();
    assert.equal(binaryScan.status, 0);
    assert.equal(binaryScan.stderr, '');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('private terms come from an untracked file, are reported by rule number only, and are optional', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'public-scan-private-'));
  try {
    mkdirSync(path.join(directory, 'scripts'));
    copyFileSync(new URL('../scripts/check-public.sh', import.meta.url), path.join(directory, 'scripts/check-public.sh'));
    assert.equal(spawnSync('git', ['init', '--quiet', directory], { encoding: 'utf8' }).status, 0);
    const list = path.join(directory, 'denylist.txt');
    const scan = () => spawnSync('bash', ['scripts/check-public.sh'], { cwd: directory, encoding: 'utf8', env: { ...process.env, PAIRPOST_PRIVATE_DENYLIST: list } });
    const word = 'zebra' + 'fish';
    writeFileSync(path.join(directory, 'sample.md'), `A note about ${word.toUpperCase()}.\nAnd Alexandria.\n`);
    assert.equal(scan().status, 0, 'no list file: only the generic rules run');
    writeFileSync(list, `# comment\n\n${word}\ncs:\\bAlex\\b\n`);
    const hit = scan();
    assert.equal(hit.status, 1);
    assert.match(hit.stdout, /sample\.md:1  \[private rule 1\]/);
    assert.doesNotMatch(hit.stdout + hit.stderr, new RegExp(word, 'i'), 'the output never repeats the term');
    assert.doesNotMatch(hit.stdout, /sample\.md:2/, 'a case-sensitive rule does not match inside another word');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
