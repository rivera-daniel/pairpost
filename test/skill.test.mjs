import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { compareSkillWithManifest, parseSkillTools, validateSkillFormat } from '../scripts/skill-contract.mjs';
import { packageSkill } from '../scripts/package-skill.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = path.join(root, 'scripts', 'check-skill.mjs');
const skillText = readFileSync(path.join(root, 'skill', 'SKILL.md'), 'utf8');
const manifestText = readFileSync(path.join(root, 'daemon', 'tools.json'), 'utf8');
const tmp = mkdtempSync(path.join(tmpdir(), 'jcs-skill-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function writeTmp(name, content) {
  const dir = path.join(tmp, `case-${n++}`);
  mkdirSync(dir);
  const file = path.join(dir, name);
  writeFileSync(file, content);
  return file;
}

function runCheck(skill = skillText, manifest = manifestText) {
  const args = [CHECK, '--skill', writeTmp('SKILL.md', skill), '--tools', writeTmp('tools.json', manifest)];
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

function editManifest(fn) {
  const m = JSON.parse(manifestText);
  fn(m);
  return JSON.stringify(m, null, 2);
}

test('the repository skill text and tool contract agree', () => {
  const res = spawnSync(process.execPath, [CHECK], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /check-skill: ok \(4 tools match\)/);
});

test('the skill parser reads names, parameters and required parameters', () => {
  const { tools, errors } = parseSkillTools(skillText);
  assert.deepEqual(errors, []);
  assert.deepEqual(tools, [
    { name: 'list_contacts', params: [], required: [] },
    { name: 'read_inbox', params: ['contact', 'after', 'limit'], required: [] },
    { name: 'draft_message', params: ['contact', 'text'], required: ['contact', 'text'] },
    { name: 'handshake_status', params: ['contact'], required: [] },
  ]);
});

test('check fails when the skill renames a tool', () => {
  const res = runCheck(skillText.replace('### `read_inbox`', '### `read_messages`'));
  assert.equal(res.status, 1);
  assert.match(res.stderr, /daemon tool "read_inbox" is missing from SKILL\.md/);
  assert.match(res.stderr, /SKILL\.md documents "read_messages", which the daemon does not expose/);
});

test('check fails when the daemon gains a tool the skill does not document', () => {
  const res = runCheck(skillText, editManifest((m) => {
    m.tools.push({ name: 'send_message', inputSchema: { type: 'object', properties: {}, required: [] } });
  }));
  assert.equal(res.status, 1);
  assert.match(res.stderr, /daemon tool "send_message" is missing from SKILL\.md/);
  assert.match(res.stderr, /exposes 5 tools/);
});

test('check fails when the daemon drops a documented tool', () => {
  const res = runCheck(skillText, editManifest((m) => {
    m.tools = m.tools.filter((t) => t.name !== 'handshake_status');
  }));
  assert.equal(res.status, 1);
  assert.match(res.stderr, /documents "handshake_status", which the daemon does not expose/);
});

test('check fails when parameters drift', () => {
  const res = runCheck(skillText, editManifest((m) => {
    const draft = m.tools.find((t) => t.name === 'draft_message');
    draft.inputSchema.properties.attachment = { type: 'string' };
    const inbox = m.tools.find((t) => t.name === 'read_inbox');
    delete inbox.inputSchema.properties.after;
    inbox.inputSchema.required = ['limit'];
  }));
  assert.equal(res.status, 1);
  assert.match(res.stderr, /draft_message: daemon parameter "attachment" is not documented/);
  assert.match(res.stderr, /read_inbox: documented parameter "after" is not accepted by the daemon/);
  assert.match(res.stderr, /read_inbox: parameter "limit" is required in the daemon but optional in SKILL\.md/);
});

test('check fails when the tool manifest is not valid JSON', () => {
  const res = runCheck(skillText, '{ "tools": [');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /tool manifest/);
});

test('format check accepts the repository skill', () => {
  assert.deepEqual(validateSkillFormat(skillText), []);
});

test('format check rejects what Claude Code or Codex would not load', () => {
  const fm = (lines) => `---\n${lines.join('\n')}\n---\n\n# Body\n`;
  const desc = 'description: Reads contacts.';
  assert.match(validateSkillFormat('# No frontmatter\n').join(), /must start with YAML frontmatter/);
  assert.match(validateSkillFormat(fm([desc])).join(), /missing "name"/);
  assert.match(validateSkillFormat(fm(['name: pairpost'])).join(), /missing "description"/);
  assert.match(validateSkillFormat(fm(['name: Pair_Post', desc])).join(), /hyphen-case/);
  assert.match(validateSkillFormat(fm(['name: other-skill', desc])).join(), /must equal the skill folder name/);
  assert.match(validateSkillFormat(fm(['name: claude-contacts', desc]), { expectedName: 'claude-contacts' }).join(), /reserved word "claude"/);
  assert.match(validateSkillFormat(fm([`name: ${'a'.repeat(65)}`, desc]), { expectedName: 'a'.repeat(65) }).join(), /maximum is 64/);
  assert.match(validateSkillFormat(fm(['name: pairpost', `description: ${'x'.repeat(1025)}`])).join(), /maximum is 1024/);
  assert.match(validateSkillFormat(fm(['name: pairpost', 'description: Use <b>this</b>.'])).join(), /must not contain < or >/);
  assert.match(validateSkillFormat(fm(['name: pairpost', desc, 'version: 1'])).join(), /unexpected key "version"/);
  assert.deepEqual(validateSkillFormat(fm(['name: pairpost', desc, 'license: MIT', 'metadata:', '  short-description: Contacts'])), []);
});

test('check fails through the CLI when the frontmatter is broken', () => {
  const res = runCheck(skillText.replace('name: pairpost', 'name: Pairpost'));
  assert.equal(res.status, 1);
  assert.match(res.stderr, /hyphen-case/);
});

test('compare reports no differences for the repository files', () => {
  assert.deepEqual(compareSkillWithManifest(skillText, manifestText), []);
});

// Minimal zip reader: walks the central directory and inflates each entry.
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'end of central directory present');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    files[name] = inflateRawSync(buf.subarray(dataStart, dataStart + size));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function copyRepo() {
  const dir = path.join(tmp, `repo-${n++}`);
  for (const rel of ['skill', 'daemon', 'LICENSE', 'VERSION']) cpSync(path.join(root, rel), path.join(dir, rel), { recursive: true });
  return dir;
}

test('packaging produces a zip, a matching SHA-256 file and a skill folder', () => {
  const repo = copyRepo();
  const out = path.join(repo, 'dist');
  const result = packageSkill({ root: repo, outDir: out });
  const version = readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  assert.equal(path.basename(result.zipPath), `pairpost-skill-${version}.zip`);

  const zip = readFileSync(result.zipPath);
  const digest = createHash('sha256').update(zip).digest('hex');
  assert.equal(result.sha256, digest);
  assert.equal(readFileSync(result.checksumPath, 'utf8'), `${digest}  ${path.basename(result.zipPath)}\n`);

  const files = readZip(zip);
  assert.deepEqual(Object.keys(files), ['pairpost/SKILL.md', 'pairpost/LICENSE']);
  assert.equal(files['pairpost/SKILL.md'].toString('utf8'), skillText);
  assert.equal(readFileSync(path.join(out, 'pairpost', 'SKILL.md'), 'utf8'), skillText);

  const again = packageSkill({ root: repo, outDir: out });
  assert.equal(again.sha256, digest, 'packaging is reproducible');
});

test('packaging refuses to run when the skill and the daemon disagree', () => {
  const repo = copyRepo();
  const skillPath = path.join(repo, 'skill', 'SKILL.md');
  writeFileSync(skillPath, skillText.replace('### `draft_message`', '### `send_message`'));
  assert.throws(() => packageSkill({ root: repo, outDir: path.join(repo, 'dist') }), /skill checks failed, not packaging/);
});
