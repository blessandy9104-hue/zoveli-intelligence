import { createInterface } from 'node:readline';
import { IntelligenceError } from './errors.js';
import { findTool } from './tools.js';
import type { IntelligenceTool } from './types.js';

export const MCP_SERVER_NAME = 'zoveli-intelligence';
export const MCP_SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_DEFAULT_PROTOCOL = MCP_SUPPORTED_PROTOCOLS[0];

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/**
 * Handle one MCP JSON-RPC message. Returns `null` for notifications, which must
 * not receive a response. Kept pure so tests can exercise the protocol without
 * spawning a process.
 */
export async function handleMcpMessage(
  tools: readonly IntelligenceTool[],
  message: unknown,
  serverInfo: McpServerInfo
): Promise<JsonRpcResponse | null> {
  if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return failure(null, -32600, 'Invalid Request');
  }
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  const id = hasId ? normalizeId(message.id) : null;
  if (!hasId) {
    // Notifications (initialized, cancelled) never get a response.
    return null;
  }

  const params = isRecord(message.params) ? message.params : {};

  switch (message.method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = (MCP_SUPPORTED_PROTOCOLS as readonly string[]).includes(requested)
        ? requested
        : MCP_DEFAULT_PROTOCOL;
      return success(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        instructions:
          'Local-first deterministic intelligence. Documents are retrieved from allowlisted folders only; ' +
          'market output is interpretation, never prediction; every answer carries verification, evidence, ' +
          'disclosures, and a hash-chained receipt.',
      });
    }
    case 'ping':
      return success(id, {});
    case 'tools/list':
      return success(id, {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters,
        })),
      });
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || !name.trim()) {
        return failure(id, -32602, 'tools/call requires params.name');
      }
      const tool = findTool(tools, name);
      if (!tool) {
        return failure(id, -32602, `Unknown tool: ${name}`);
      }
      const args = params.arguments;
      if (args !== undefined && (!isRecord(args) || Array.isArray(args))) {
        return failure(id, -32602, 'params.arguments must be an object');
      }
      try {
        const result = await tool.execute((args ?? {}) as Record<string, unknown>);
        const payload: Record<string, unknown> = {
          content: [{ type: 'text', text: stringifyResult(result) }],
        };
        if (isRecord(result) && !Array.isArray(result)) payload.structuredContent = result;
        return success(id, payload);
      } catch (error) {
        return success(id, toolError(error));
      }
    }
    default:
      return failure(id, -32601, `Method not found: ${message.method}`);
  }
}

/**
 * Serve MCP over newline-delimited JSON-RPC on stdio. Nothing except protocol
 * messages is ever written to stdout.
 */
export async function runMcpServer(options: {
  tools: readonly IntelligenceTool[];
  serverInfo: McpServerInfo;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const lines = createInterface({ input, crlfDelay: Infinity });
  let queue: Promise<void> = Promise.resolve();

  const write = (response: JsonRpcResponse | null): void => {
    if (!response) return;
    output.write(`${JSON.stringify(response)}\n`);
  };

  for await (const line of lines) {
    if (!line.trim()) continue;
    queue = queue.then(async () => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        write(failure(null, -32700, 'Parse error'));
        return;
      }
      try {
        write(await handleMcpMessage(options.tools, message, options.serverInfo));
      } catch (error) {
        write(failure(null, -32603, 'Internal error', errorText(error)));
      }
    });
  }
  await queue;
}

function success(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

function failure(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcFailure {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

function toolError(error: unknown): Record<string, unknown> {
  const code = error instanceof IntelligenceError ? error.code : 'INTEL_ERROR';
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof IntelligenceError ? error.details : undefined;
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    isError: true,
    structuredContent: { code, message, details: details ?? null },
  };
}

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function normalizeId(value: unknown): string | number | null {
  if (typeof value === 'string' || typeof value === 'number') return value;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
