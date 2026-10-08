#!/usr/bin/env node
// Pairpost daemon entry point. Zero dependencies, Node 22.
//
//   node daemon/main.mjs serve    MCP server on stdio with the four read-only tools (default)
//   node daemon/main.mjs review   local approval console for held drafts and message release
//
// Drafts persist in PAIRPOST_STATE_DIR (default ~/.local/state/pairpost) so the
// console can run in a separate terminal from the MCP host. The protocol core is not built
// yet: createCore returns the in-memory mock. Replace that one function to drop the real core in.

import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMockCore } from './mock-core.mjs';
import { assertCoreClient } from './core-client.mjs';
import { createDraftStore } from './drafts.mjs';
import { createTools } from './tools.mjs';
import { createMcpServer, serveStdio } from './mcp.mjs';
import { runApprovalConsole } from './approval.mjs';

export const VERSION = '0.0.0';

export function createCore() {
  return assertCoreClient(createMockCore());
}

export function stateDir(env = process.env) {
  return env.PAIRPOST_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'pairpost');
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const command = argv[0] ?? 'serve';
  const core = createCore();
  const drafts = createDraftStore({ file: path.join(stateDir(env), 'drafts.json') });

  if (command === 'serve') {
    process.stderr.write('pairpost: using the in-memory mock core (design preview)\n');
    const server = createMcpServer({ tools: createTools({ core, drafts }), name: 'pairpost', version: VERSION });
    await serveStdio({ server, input: process.stdin, output: process.stdout });
    return 0;
  }
  if (command === 'review') {
    const summary = await runApprovalConsole({ drafts, core, input: process.stdin, output: process.stdout });
    process.stdout.write(`\nApproved ${summary.approved}, refused ${summary.refused}, released ${summary.released}.\n`);
    return 0;
  }
  process.stderr.write('usage: node daemon/main.mjs [serve|review]\n');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`pairpost: ${err.message}\n`);
    process.exitCode = 1;
  });
}
