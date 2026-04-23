import * as fs from 'fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type McpJsonFile = {
  mcpServers?: Record<string, McpServerConfig>;
};

export type LoadedMcp = {
  path: string;
  clients: Map<
    string,
    {
      client: Client;
      transport: StdioClientTransport;
      tools: Tool[];
    }
  >;
};

export async function loadMcpFromPath(filePath: string): Promise<LoadedMcp> {
  const raw = await fs.readFile(filePath, 'utf8');
  const json = JSON.parse(raw) as McpJsonFile;
  const servers = json.mcpServers ?? {};
  const clients = new Map<string, { client: Client; transport: StdioClientTransport; tools: Tool[] }>();
  for (const [name, cfg] of Object.entries(servers)) {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
    });
    const client = new Client({ name: `qingcoder-${name}`, version: '0.1.0' });
    await client.connect(transport);
    const listed = await client.listTools();
    clients.set(name, { client, transport, tools: listed.tools });
  }
  return { path: filePath, clients };
}

export async function shutdownMcp(loaded: LoadedMcp | null): Promise<void> {
  if (!loaded) return;
  for (const [, v] of loaded.clients) {
    try {
      await v.client.close();
    } catch {
      /* noop */
    }
  }
}

export function flattenTools(loaded: LoadedMcp): { server: string; tool: Tool }[] {
  const out: { server: string; tool: Tool }[] = [];
  for (const [server, v] of loaded.clients) {
    for (const tool of v.tools) out.push({ server, tool });
  }
  return out;
}

export async function callMcpTool(
  loaded: LoadedMcp,
  server: string,
  toolName: string,
  args: unknown
): Promise<unknown> {
  const v = loaded.clients.get(server);
  if (!v) throw new Error(`未知 MCP 服务: ${server}`);
  const res = await v.client.callTool({ name: toolName, arguments: args as Record<string, unknown> });
  return res;
}
