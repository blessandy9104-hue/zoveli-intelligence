import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIntelligence } from '../src/index.js';
import {
  MCP_DEFAULT_PROTOCOL,
  handleMcpMessage,
  runMcpServer,
} from '../src/mcp.js';
import { createIntelligenceTools } from '../src/tools.js';
import { createWorkspace, fixedClock, type Workspace } from './helpers.js';

const SERVER_INFO = { name: 'zoveli-intelligence', version: '0.1.0' };

function resultOf(response: unknown): Record<string, any> {
  const value = response as { result?: Record<string, any>; error?: unknown };
  expect(value.error).toBeUndefined();
  expect(value.result).toBeDefined();
  return value.result as Record<string, any>;
}

describe('MCP server', () => {
  let ws: Workspace;
  let tools: ReturnType<typeof createIntelligenceTools>;

  beforeEach(() => {
    ws = createWorkspace();
    const governor = createIntelligence({
      dataDir: ws.dataDir,
      roots: [ws.root],
      now: fixedClock(),
    });
    tools = createIntelligenceTools(governor);
  });

  afterEach(() => ws.cleanup());

  it('initializes with the requested supported protocol', async () => {
    const response = await handleMcpMessage(
      tools,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      SERVER_INFO
    );
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      },
    });
  });

  it('falls back to the default protocol for unknown versions', async () => {
    const response = await handleMcpMessage(
      tools,
      { jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: '1999-01-01' } },
      SERVER_INFO
    );
    expect(resultOf(response).protocolVersion).toBe(MCP_DEFAULT_PROTOCOL);
  });

  it('ignores notifications', async () => {
    const response = await handleMcpMessage(
      tools,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      SERVER_INFO
    );
    expect(response).toBeNull();
  });

  it('lists every tool with its JSON schema', async () => {
    const response = await handleMcpMessage(
      tools,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      SERVER_INFO
    );
    const list = resultOf(response).tools;
    expect(list).toHaveLength(16);
    expect(list[0]).toHaveProperty('inputSchema');
  });

  it('calls a tool and returns text plus structured content', async () => {
    const response = await handleMcpMessage(
      tools,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'intel_status', arguments: {} },
      },
      SERVER_INFO
    );
    const result = resultOf(response);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text).name).toBe('@zoveli/intelligence');
    expect(result.structuredContent.name).toBe('@zoveli/intelligence');
  });

  it('returns tool errors as MCP tool results, not protocol errors', async () => {
    const response = await handleMcpMessage(
      tools,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'intel_docs_answer', arguments: {} },
      },
      SERVER_INFO
    );
    const result = resultOf(response);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INTEL_INPUT');
    expect(result.structuredContent.code).toBe('INTEL_INPUT');
  });

  it('rejects unknown tools and malformed arguments', async () => {
    const unknown = await handleMcpMessage(
      tools,
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } },
      SERVER_INFO
    );
    expect(unknown).toMatchObject({ error: { code: -32602 } });

    const badArgs = await handleMcpMessage(
      tools,
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'intel_status', arguments: [] } },
      SERVER_INFO
    );
    expect(badArgs).toMatchObject({ error: { code: -32602 } });
  });

  it('rejects unknown methods and invalid requests', async () => {
    const method = await handleMcpMessage(
      tools,
      { jsonrpc: '2.0', id: 7, method: 'resources/list' },
      SERVER_INFO
    );
    expect(method).toMatchObject({ error: { code: -32601 } });

    const request = await handleMcpMessage(tools, { id: 8, method: 'ping' }, SERVER_INFO);
    expect(request).toMatchObject({ error: { code: -32600 } });
  });

  it('serves newline-delimited JSON-RPC and survives parse errors', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });

    const done = runMcpServer({ tools, serverInfo: SERVER_INFO, input, output });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    input.write('{not json\n');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    input.end();
    await done;
    await new Promise((resolve) => setImmediate(resolve));

    const responses = text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>);

    expect(responses).toHaveLength(3);
    expect(responses[0].result.serverInfo).toEqual(SERVER_INFO);
    expect(responses[1]).toMatchObject({ error: { code: -32700 } });
    expect(responses[2].result.tools).toHaveLength(16);
  });
});
