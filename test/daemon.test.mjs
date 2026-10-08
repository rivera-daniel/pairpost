import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockCore, MOCK_KEY_SENTINELS } from '../daemon/mock-core.mjs';
import { assertCoreClient, CORE_CLIENT_METHODS } from '../daemon/core-client.mjs';
import { createDraftStore, DRAFT_STATUS, MAX_HELD_DRAFTS } from '../daemon/drafts.mjs';
import { createTools, TOOL_NAMES } from '../daemon/tools.mjs';
import { createMcpServer, serveStdio } from '../daemon/mcp.mjs';
import { runApprovalConsole } from '../daemon/approval.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON_DIR = path.join(ROOT, 'daemon');

function setup(coreOptions) {
  const core = createMockCore(coreOptions);
  const drafts = createDraftStore();
  const server = createMcpServer({ tools: createTools({ core, drafts }), name: 'test', version: '0' });
  let nextId = 1;
  const rpc = (method, params) => server.handle({ jsonrpc: '2.0', id: nextId++, method, params });
  /** Call a tool and return { isError, value } where value is the parsed JSON or the error text. */
  async function call(name, args) {
    const res = await rpc('tools/call', { name, arguments: args });
    assert.ok(res.result, `expected a result, got ${JSON.stringify(res)}`);
    const text = res.result.content[0].text;
    return res.result.isError ? { isError: true, value: text } : { isError: false, value: JSON.parse(text) };
  }
  return { core, drafts, server, rpc, call };
}

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Daemon source files with comments removed, so documentation cannot trip or hide a check. */
const daemonSources = () =>
  readdirSync(DAEMON_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => ({ file: f, text: stripComments(readFileSync(path.join(DAEMON_DIR, f), 'utf8')) }));

// ---- exact tool list ----

test('the daemon exposes exactly four tools', async () => {
  const { rpc } = setup();
  const res = await rpc('tools/list');
  assert.deepEqual(res.result.tools.map((t) => t.name).sort(), ['draft_message', 'handshake_status', 'list_contacts', 'read_inbox']);
  assert.deepEqual([...TOOL_NAMES].sort(), ['draft_message', 'handshake_status', 'list_contacts', 'read_inbox']);
});

test('the server refuses to start with an extra or missing tool', () => {
  const core = createMockCore();
  const drafts = createDraftStore();
  const tools = createTools({ core, drafts });
  const extra = { name: 'run_command', description: 'x', inputSchema: {}, annotations: {}, handler: async () => ({}) };
  assert.throws(() => createMcpServer({ tools: [...tools, extra], name: 't', version: '0' }), /exactly/);
  assert.throws(() => createMcpServer({ tools: tools.slice(1), name: 't', version: '0' }), /exactly/);
  assert.throws(() => createMcpServer({ tools: [...tools.slice(1), { ...extra }], name: 't', version: '0' }), /exactly/);
});

test('calling any other tool name fails', async () => {
  const { rpc } = setup();
  for (const name of ['send_message', 'release_message', 'read_file', 'run_command', 'fetch', 'memory_search', '__proto__', 'constructor']) {
    const res = await rpc('tools/call', { name, arguments: {} });
    assert.equal(res.error?.code, -32602, name);
  }
});

test('the server declares the tools capability only and rejects other methods', async () => {
  const { rpc } = setup();
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } });
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  for (const method of ['resources/list', 'prompts/list', 'sampling/createMessage', 'logging/setLevel', 'completion/complete']) {
    assert.equal((await rpc(method, {})).error.code, -32601, method);
  }
  assert.deepEqual((await rpc('ping')).result, {});
});

test('tool annotations mark the three read tools read-only and nothing as open-world', async () => {
  const { rpc } = setup();
  const { tools } = (await rpc('tools/list')).result;
  for (const t of tools) {
    assert.equal(t.annotations.openWorldHint, false);
    assert.equal(t.annotations.destructiveHint, false);
    assert.equal(t.annotations.readOnlyHint, t.name !== 'draft_message', t.name);
    assert.equal(t.inputSchema.additionalProperties, false);
  }
});

// ---- list_contacts ----

test('list_contacts returns the documented fields only', async () => {
  const { call } = setup();
  const { value } = await call('list_contacts', {});
  assert.deepEqual(value.contacts.map((c) => c.id), ['c-sam', 'c-robin']);
  assert.deepEqual(Object.keys(value.contacts[0]).sort(), ['fingerprint', 'grants', 'id', 'petname', 'state']);
  assert.equal(value.contacts[0].state, 'active');
  assert.equal(value.contacts[1].state, 'pending');
  assert.deepEqual(value.contacts[0].grants, { read_released: true });
});

test('list_contacts rejects arguments', async () => {
  const { call } = setup();
  const res = await call('list_contacts', { contact: 'c-sam' });
  assert.equal(res.isError, true);
  assert.match(res.value, /unknown argument/);
});

// ---- read_inbox ----

test('read_inbox returns metadata only until the human releases a message', async () => {
  const { call, core } = setup();
  const before = (await call('read_inbox', {})).value;
  assert.equal(before.items.length, 2);
  for (const item of before.items) {
    assert.deepEqual(Object.keys(item).sort(), ['contact', 'id', 'kind', 'received_at', 'released', 'size']);
    assert.equal(item.released, false);
    assert.equal('message' in item, false);
  }
  assert.doesNotMatch(JSON.stringify(before), /sample contact|draft ready/i);

  assert.equal(await core.releaseMessage('m-1'), true);
  const after = (await call('read_inbox', {})).value;
  const first = after.items.find((i) => i.id === 'm-1');
  const second = after.items.find((i) => i.id === 'm-2');
  assert.equal(first.released, true);
  assert.deepEqual(first.message, { fields: { text: 'Hello from the sample contact.' }, untrusted: true });
  assert.equal('message' in second, false);
});

test('read_inbox filters by contact and pages with a cursor', async () => {
  const { call } = setup();
  const page1 = (await call('read_inbox', { limit: 1 })).value;
  assert.deepEqual(page1.items.map((i) => i.id), ['m-1']);
  assert.equal(page1.next, 'm-1');
  const page2 = (await call('read_inbox', { limit: 1, after: page1.next })).value;
  assert.deepEqual(page2.items.map((i) => i.id), ['m-2']);
  assert.equal('next' in page2, false);
  assert.deepEqual((await call('read_inbox', { contact: 'c-robin' })).value.items, []);
  assert.equal((await call('read_inbox', { after: 'nope' })).isError, true);
});

test('read_inbox validates its arguments', async () => {
  const { call } = setup();
  for (const args of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: '5' }, { contact: '../x' }, { contact: 7 }, { path: '/etc/passwd' }]) {
    assert.equal((await call('read_inbox', args)).isError, true, JSON.stringify(args));
  }
});

test('a message from an unknown or pending sender is never stored or listed', async () => {
  const { call, core } = setup();
  const msg = { kind: 'text', receivedAt: '2026-10-03T00:00:00.000Z', fields: { text: 'hi' } };
  assert.equal(core.receive({ ...msg, id: 'x-1', contactId: 'c-stranger' }), false);
  assert.equal(core.receive({ ...msg, id: 'x-2', contactId: 'c-robin' }), false);
  assert.equal(core.receive({ ...msg, id: 'x-3', contactId: 'c-sam' }), true);
  const ids = (await call('read_inbox', {})).value.items.map((i) => i.id);
  assert.deepEqual(ids, ['m-1', 'm-2', 'x-3']);
});

test('released message content is capped and marked untrusted', async () => {
  const big = 'a'.repeat(40000);
  const { call, core } = setup({
    messages: [{ id: 'big', contactId: 'c-sam', kind: 'text', receivedAt: '2026-10-01T00:00:00.000Z', fields: { text: big } }],
  });
  await core.releaseMessage('big');
  const item = (await call('read_inbox', {})).value.items[0];
  assert.equal(item.message.untrusted, true);
  assert.equal(item.message.truncated, true);
  assert.equal(item.message.fields.text.length, 16384);
});

// ---- draft_message ----

test('draft_message holds the draft for approval and returns no more than its id and status', async () => {
  const { call, drafts } = setup();
  const res = await call('draft_message', { contact: 'c-sam', text: 'Thanks, see you Friday.' });
  assert.equal(res.isError, false);
  assert.deepEqual(Object.keys(res.value).sort(), ['draft_id', 'status']);
  assert.equal(res.value.status, 'held_for_approval');
  const stored = drafts.list();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, res.value.draft_id);
  assert.equal(stored[0].status, DRAFT_STATUS.HELD);
  assert.equal(stored[0].text, 'Thanks, see you Friday.');
  assert.equal(stored[0].contactId, 'c-sam');
});

test('draft_message refuses unknown and inactive contacts', async () => {
  const { call, drafts } = setup();
  assert.match((await call('draft_message', { contact: 'c-nobody', text: 'hi' })).value, /unknown contact/);
  assert.match((await call('draft_message', { contact: 'c-robin', text: 'hi' })).value, /not active/);
  assert.equal(drafts.list().length, 0);
});

test('draft_message validates text and arguments', async () => {
  const { call, drafts } = setup();
  const cases = [
    { contact: 'c-sam' },
    { text: 'hi' },
    { contact: 'c-sam', text: '' },
    { contact: 'c-sam', text: 'x'.repeat(8193) },
    { contact: 'c-sam', text: 'bell\u0007' },
    { contact: 'c-sam', text: 'escape\u001b[2J' },
    { contact: 'c-sam', text: 'hi', send: true },
    { contact: 'c-sam', text: 42 },
  ];
  for (const args of cases) assert.equal((await call('draft_message', args)).isError, true, JSON.stringify(args));
  assert.equal(drafts.list().length, 0);
  assert.equal((await call('draft_message', { contact: 'c-sam', text: 'line one\nline two\tend' })).isError, false);
  assert.equal((await call('draft_message', { contact: 'c-sam', text: 'x'.repeat(8192) })).isError, false);
});

test('draft_message reports when too many drafts wait for the human', async () => {
  const { call, drafts } = setup();
  for (let i = 0; i < MAX_HELD_DRAFTS; i += 1) drafts.create({ contactId: 'c-sam', text: `d${i}` });
  assert.match((await call('draft_message', { contact: 'c-sam', text: 'one more' })).value, /too many drafts/);
});

test('a draft store failure other than the cap is reported as an internal error', async () => {
  const { call, drafts } = setup();
  drafts.create = () => {
    throw new Error('EACCES: permission denied');
  };
  const res = await call('draft_message', { contact: 'c-sam', text: 'hello' });
  assert.deepEqual(res, { isError: true, value: 'internal error' });
});

test('no tool call changes a draft status or releases a message', async () => {
  const { call, drafts, core } = setup();
  const { value } = await call('draft_message', { contact: 'c-sam', text: 'hello' });
  await call('read_inbox', {});
  await call('list_contacts', {});
  await call('handshake_status', {});
  assert.equal(drafts.list()[0].status, 'held_for_approval');
  assert.equal(drafts.list()[0].id, value.draft_id);
  assert.ok((await core.listInbox()).every((m) => m.released === false));
});

// ---- handshake_status ----

test('handshake_status reports state, start and expiry', async () => {
  const { call } = setup();
  const all = (await call('handshake_status', {})).value.contacts;
  const sam = all.find((c) => c.contact === 'c-sam');
  const robin = all.find((c) => c.contact === 'c-robin');
  assert.deepEqual(sam, { contact: 'c-sam', state: 'active', started_at: '2026-09-01T10:00:00.000Z' });
  assert.deepEqual(robin, { contact: 'c-robin', state: 'pending', started_at: '2026-09-28T10:00:00.000Z', expires_at: '2026-10-28T10:00:00.000Z' });
  assert.deepEqual((await call('handshake_status', { contact: 'c-robin' })).value.contacts, [robin]);
  assert.match((await call('handshake_status', { contact: 'c-nobody' })).value, /unknown contact/);
});

test('a pending handshake older than thirty days reports expired', async () => {
  const { call } = setup({ now: () => new Date('2026-12-01T00:00:00.000Z') });
  const robin = (await call('handshake_status', { contact: 'c-robin' })).value.contacts[0];
  assert.equal(robin.state, 'expired');
  assert.equal('expires_at' in robin, false);
  assert.equal((await call('draft_message', { contact: 'c-robin', text: 'hi' })).isError, true);
});

// ---- keys never cross into tool results ----

test('no tool result contains key material', async () => {
  const { call, core } = setup();
  await core.releaseMessage('m-1');
  const results = [
    await call('list_contacts', {}),
    await call('read_inbox', {}),
    await call('read_inbox', { contact: 'c-sam', limit: 1 }),
    await call('draft_message', { contact: 'c-sam', text: 'hello' }),
    await call('draft_message', { contact: 'c-robin', text: 'hello' }),
    await call('handshake_status', {}),
    await call('handshake_status', { contact: 'c-sam' }),
  ];
  const serialized = JSON.stringify(results);
  for (const secret of Object.values(MOCK_KEY_SENTINELS)) assert.equal(serialized.includes(secret), false, secret);
  assert.doesNotMatch(serialized, /SENTINEL|private|secret|seed/i);
});

test('fields a core returns beyond the contract are dropped', async () => {
  const inner = createMockCore();
  await inner.releaseMessage('m-1');
  const leak = { sessionKey: MOCK_KEY_SENTINELS.sessionKey, privateKey: MOCK_KEY_SENTINELS.identityKey };
  const leaky = {
    ...inner,
    listContacts: async () => (await inner.listContacts()).map((c) => ({ ...c, ...leak, grants: { ...c.grants, ...leak } })),
    listInbox: async (f) => (await inner.listInbox(f)).map((m) => ({ ...m, ...leak })),
    readMessage: async (id) => {
      const m = await inner.readMessage(id);
      return m && { ...m, ...leak };
    },
    handshakeStatus: async (id) => (await inner.handshakeStatus(id)).map((h) => ({ ...h, ...leak })),
  };
  const drafts = createDraftStore();
  const server = createMcpServer({ tools: createTools({ core: leaky, drafts }), name: 't', version: '0' });
  const outputs = [];
  for (const name of ['list_contacts', 'read_inbox', 'handshake_status']) {
    outputs.push(await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }));
  }
  const serialized = JSON.stringify(outputs);
  assert.ok(serialized.includes('Hello from the sample contact.'));
  for (const secret of Object.values(MOCK_KEY_SENTINELS)) assert.equal(serialized.includes(secret), false, secret);
});

test('internal errors are not echoed to the model', async () => {
  const core = createMockCore();
  core.listContacts = async () => {
    throw new Error(`boom ${MOCK_KEY_SENTINELS.sessionKey}`);
  };
  const server = createMcpServer({ tools: createTools({ core, drafts: createDraftStore() }), name: 't', version: '0' });
  const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_contacts', arguments: {} } });
  assert.equal(res.result.isError, true);
  assert.equal(res.result.content[0].text, 'internal error');
});

// ---- CoreClient ----

test('CoreClient is a five-method interface that the mock satisfies', () => {
  assert.deepEqual([...CORE_CLIENT_METHODS], ['listContacts', 'listInbox', 'readMessage', 'releaseMessage', 'handshakeStatus']);
  assert.equal(assertCoreClient(createMockCore()) !== undefined, true);
  assert.throws(() => assertCoreClient({}), /missing method/);
  assert.throws(() => assertCoreClient(null), /object/);
  const partial = createMockCore();
  delete partial.readMessage;
  assert.throws(() => assertCoreClient(partial), /readMessage/);
});

test('the tools never call releaseMessage', () => {
  const tools = readFileSync(path.join(DAEMON_DIR, 'tools.mjs'), 'utf8');
  assert.equal(/releaseMessage/.test(stripComments(tools)), false);
});

// ---- draft store ----

test('the draft store persists across instances, refuses repeat decisions and keeps the file private', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jcd-'));
  try {
    const file = path.join(dir, 'state', 'drafts.json');
    const a = createDraftStore({ file });
    const draft = a.create({ contactId: 'c-sam', text: 'hello' });
    const b = createDraftStore({ file });
    assert.deepEqual(b.list(DRAFT_STATUS.HELD).map((d) => d.id), [draft.id]);
    assert.equal(b.decide(draft.id, DRAFT_STATUS.APPROVED).status, 'approved');
    assert.equal(b.decide(draft.id, DRAFT_STATUS.REFUSED), null);
    assert.equal(a.list()[0].status, 'approved');
    assert.throws(() => a.decide(draft.id, 'sent'), /invalid decision/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- human approval console ----

async function runConsole(answers, setupResult) {
  const { drafts, core } = setupResult;
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (d) => (text += d));
  const done = runApprovalConsole({ drafts, core, input, output });
  input.end(answers);
  const summary = await done;
  return { summary, text };
}

test('the approval console approves, refuses and releases on the human answer', async () => {
  const s = setup();
  const d1 = s.drafts.create({ contactId: 'c-sam', text: 'first' });
  const d2 = s.drafts.create({ contactId: 'c-sam', text: 'second' });
  const d3 = s.drafts.create({ contactId: 'c-sam', text: 'third' });
  const { summary, text } = await runConsole('a\nr\ns\nx\nr\ns\n', s);
  assert.deepEqual(summary, { approved: 1, refused: 1, released: 1 });
  const status = Object.fromEntries(s.drafts.list().map((d) => [d.id, d.status]));
  assert.deepEqual(status, { [d1.id]: 'approved', [d2.id]: 'refused', [d3.id]: 'held_for_approval' });
  assert.match(text, /Please answer one of/);
  assert.deepEqual((await s.core.listInbox()).map((m) => m.released), [true, false]);
  assert.equal((await s.call('read_inbox', {})).value.items[0].message.fields.text, 'Hello from the sample contact.');
});

test('the approval console leaves everything held when the input ends', async () => {
  const s = setup();
  s.drafts.create({ contactId: 'c-sam', text: 'first' });
  const { summary } = await runConsole('', s);
  assert.deepEqual(summary, { approved: 0, refused: 0, released: 0 });
  assert.equal(s.drafts.list()[0].status, 'held_for_approval');
  assert.ok((await s.core.listInbox()).every((m) => !m.released));
});

test('the approval console neutralizes terminal control characters in drafts', async () => {
  const s = setup();
  s.drafts.create({ contactId: 'c-sam', text: 'clear\u001b[2Jscreen' });
  const { text } = await runConsole('s\ns\ns\n', s);
  assert.equal(text.includes('\u001b'), false);
  assert.ok(text.includes('clear·[2Jscreen'));
});

// ---- no send path, no other capability ----

test('no source file contains a send primitive', () => {
  const forbidden = [
    /\b(send|deliver|transmit|dispatch|publish|broadcast|relay)[A-Za-z]*\s*\(/i,
    /\.\s*(send|write)To\b/,
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bWebSocket\b/,
    /\bEventSource\b/,
    /\bnavigator\b/,
    /\bsendBeacon\b/,
    /\bprocess\.(binding|dlopen)\b/,
    /\beval\s*\(/,
    /\bnew\s+Function\b/,
    /\bimport\s*\(/,
    /\brequire\s*\(/,
  ];
  const sources = daemonSources();
  assert.ok(sources.length >= 6);
  for (const { file, text } of sources) {
    for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${file} matches ${pattern}`);
  }
});

test('no source file imports a network, process or shell module', () => {
  const banned = /node:(net|http|https|http2|dgram|tls|dns|child_process|cluster|worker_threads|vm|inspector|repl|zlib)\b/;
  for (const { file, text } of daemonSources()) assert.doesNotMatch(text, banned, file);
});

test('only the draft store touches the file system', () => {
  for (const { file, text } of daemonSources()) {
    const usesFs = /from\s+'node:fs(\/promises)?'/.test(text);
    assert.equal(usesFs, file === 'drafts.mjs', file);
  }
});

test('the daemon exposes no tool, resource or prompt for files, shell, fetch or memory', async () => {
  const { rpc } = setup();
  const { tools } = (await rpc('tools/list')).result;
  const blob = JSON.stringify(tools);
  for (const word of ['file', 'path', 'shell', 'command', 'url', 'memory']) {
    assert.equal(new RegExp(`"${word}"`, 'i').test(blob), false, word);
  }
});

// ---- zero dependencies ----

test('the daemon has zero runtime dependencies', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
    assert.equal(key in pkg, false, key);
  }
  assert.equal(existsSync(path.join(ROOT, 'node_modules')), false);
  for (const lock of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb']) {
    assert.equal(existsSync(path.join(ROOT, lock)), false, lock);
  }
  assert.match(pkg.engines.node, />=22/);
});

test('every import in the daemon is a node: builtin or a sibling file', () => {
  for (const { file, text } of daemonSources()) {
    const specifiers = [...text.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]);
    for (const spec of specifiers) assert.match(spec, /^(node:[a-z/_]+|\.\/[a-z-]+\.mjs)$/, `${file}: ${spec}`);
  }
});

// ---- stdio transport ----

test('serveStdio answers one JSON-RPC message per line and survives bad input', async () => {
  const { server } = setup();
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (d) => (text += d));
  const done = serveStdio({ server, input, output });
  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  input.write('not json\n');
  input.write('[1,2]\n');
  input.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  input.end();
  await done;
  const replies = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(replies.map((r) => r.id), [1, null, null, 2]);
  assert.equal(replies[1].error.code, -32700);
  assert.equal(replies[2].error.code, -32600);
  assert.equal(replies[3].result.tools.length, 4);
});

test('the daemon process serves the four tools over stdio', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jcd-'));
  try {
    const child = spawn(process.execPath, [path.join(DAEMON_DIR, 'main.mjs'), 'serve'], {
      env: { ...process.env, PAIRPOST_STATE_DIR: dir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"draft_message","arguments":{"contact":"c-sam","text":"hi"}}}\n');
    child.stdin.end();
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0);
    const [list, draft] = out.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(list.result.tools.length, 4);
    assert.equal(JSON.parse(draft.result.content[0].text).status, 'held_for_approval');
    const saved = JSON.parse(readFileSync(path.join(dir, 'drafts.json'), 'utf8'));
    assert.equal(saved[0].status, 'held_for_approval');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
