import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LoadedMcp } from '../mcp/mcpHost';
import { callMcpTool, flattenTools } from '../mcp/mcpHost';
import type { EditLedger } from '../editor/editLedger';

export type ToolCall = { name: string; args: Record<string, unknown> };

function resolvePath(p: string, root: string | undefined): string {
  if (path.isAbsolute(p)) return p;
  if (!root) return p;
  return path.join(root, p);
}

async function readText(abs: string): Promise<string> {
  return fs.readFile(abs, 'utf8');
}

async function walkList(dir: string, max = 200): Promise<string[]> {
  const out: string[] = [];
  async function inner(d: string) {
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (out.length >= max) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        await inner(full);
      } else {
        out.push(full);
      }
    }
  }
  await inner(dir);
  return out;
}

export async function executeTool(
  call: ToolCall,
  ctx: { root: string | undefined; ledger: EditLedger; mcp: LoadedMcp | null }
): Promise<string> {
  const root = ctx.root;
  try {
    if (call.name === 'list_dir') {
      const rel = String(call.args.path ?? '.');
      const abs = resolvePath(rel, root);
      const names = await fs.readdir(abs).catch(() => []);
      return JSON.stringify({ ok: true, entries: names });
    }
    if (call.name === 'read_file') {
      const abs = resolvePath(String(call.args.path), root);
      const text = await readText(abs);
      return JSON.stringify({ ok: true, path: abs, content: text });
    }
    if (call.name === 'write_file') {
      const abs = resolvePath(String(call.args.path), root);
      const content = String(call.args.content ?? '');
      const uri = vscode.Uri.file(abs);
      await ctx.ledger.applyFullFileWrite(uri, content);
      return JSON.stringify({ ok: true, path: abs, message: '已写入并进入可撤销批次' });
    }
    if (call.name === 'search_text') {
      const q = String(call.args.query ?? '');
      const glob = String(call.args.glob ?? '**/*');
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) return JSON.stringify({ ok: false, error: '无工作区文件夹' });
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, glob),
        '**/node_modules/**',
        200
      );
      const hits: { file: string; line: number; text: string }[] = [];
      for (const f of files) {
        const txt = await fs.readFile(f.fsPath, 'utf8').catch(() => '');
        const lines = txt.split('\n');
        lines.forEach((line, idx) => {
          if (line.includes(q)) hits.push({ file: f.fsPath, line: idx + 1, text: line.trim().slice(0, 200) });
        });
        if (hits.length > 80) break;
      }
      return JSON.stringify({ ok: true, hits });
    }
    if (call.name === 'mcp_tool') {
      if (!ctx.mcp) return JSON.stringify({ ok: false, error: 'MCP 未加载' });
      const server = String(call.args.server ?? '');
      const tool = String(call.args.tool ?? '');
      const args = (call.args.arguments ?? {}) as unknown;
      const res = await callMcpTool(ctx.mcp, server, tool, args);
      return JSON.stringify({ ok: true, result: res });
    }
    return JSON.stringify({ ok: false, error: `未知工具: ${call.name}` });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return JSON.stringify({ ok: false, error: msg });
  }
}

export function mcpToolSummary(mcp: LoadedMcp | null): string {
  if (!mcp) return '';
  const flat = flattenTools(mcp);
  if (!flat.length) return '';
  const lines = flat.map(
    (x) =>
      `- mcp_tool: server=${JSON.stringify(x.server)} tool=${JSON.stringify(x.tool.name)} schema=${JSON.stringify(
        x.tool.inputSchema ?? {}
      )}`
  );
  return ['此外可通过 MCP 调用（使用工具 mcp_tool）：', ...lines].join('\n');
}
