// Minimal MCP server over newline-delimited JSON-RPC 2.0 on stdio. It implements initialize,
// ping, tools/list and tools/call, and declares the tools capability only: no resources,
// prompts, sampling or logging.

import readline from 'node:readline';
import { ToolError, assertExactTools } from './tools.mjs';

export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/**
 * @param {{ tools: Array<{name: string, description: string, inputSchema: object, annotations: object, handler: Function}>, name: string, version: string }} options
 */
export function createMcpServer({ tools, name, version }) {
  assertExactTools(tools);
  const byName = new Map(tools.map((t) => [t.name, t]));

  async function callTool(params) {
    const tool = typeof params?.name === 'string' ? byName.get(params.name) : undefined;
    if (!tool) return { error: [-32602, 'unknown tool'] };
    if (params.arguments !== undefined && (typeof params.arguments !== 'object' || params.arguments === null || Array.isArray(params.arguments))) {
      return { error: [-32602, 'arguments must be an object'] };
    }
    try {
      const value = await tool.handler(params.arguments);
      return { result: { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] } };
    } catch (err) {
      const text = err instanceof ToolError ? err.message : 'internal error';
      return { result: { isError: true, content: [{ type: 'text', text }] } };
    }
  }

  /** Handle one parsed message. Returns the response object, or null for a notification. */
  async function handle(message) {
    if (message === null || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return fail(message && typeof message === 'object' && !Array.isArray(message) && 'id' in message ? message.id : null, -32600, 'invalid request');
    }
    if (!('id' in message)) return null;
    const { id, method, params } = message;
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
        return ok(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version } });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: tools.map(({ name: n, description, inputSchema, annotations }) => ({ name: n, description, inputSchema, annotations })) });
      case 'tools/call': {
        const outcome = await callTool(params);
        return outcome.error ? fail(id, ...outcome.error) : ok(id, outcome.result);
      }
      default:
        return fail(id, -32601, 'method not found');
    }
  }

  return { handle };
}

/** Read one JSON message per line from `input`, write one response per line to `output`. */
export async function serveStdio({ server, input, output }) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    let response;
    try {
      response = await server.handle(JSON.parse(line));
    } catch (err) {
      response = err instanceof SyntaxError ? fail(null, -32700, 'parse error') : fail(null, -32603, 'internal error');
    }
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}
