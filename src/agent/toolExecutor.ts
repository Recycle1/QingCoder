import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LoadedMcp } from '../mcp/mcpHost';
import { callMcpTool, flattenTools } from '../mcp/mcpHost';
import type { EditLedger } from '../editor/editLedger';
import type { ToolCall } from './toolParse';

export type { ToolCall };

type LineHunk = { startLine: number; endLine: number; newContent: string };

/** 1-based 闭区间行号，自下而上应用，避免行号漂移 */
export function applyLinePatches(source: string, hunks: LineHunk[]): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const sorted = [...hunks].sort((a, b) => b.startLine - a.startLine);
  for (const h of sorted) {
    const s = Math.max(1, Math.floor(h.startLine)) - 1;
    const e = Math.max(s, Math.floor(h.endLine) - 1);
    if (s >= lines.length) throw new Error(`startLine ${h.startLine} 超出文件行数`);
    if (e >= lines.length) throw new Error(`endLine ${h.endLine} 超出文件行数`);
    const newLines = String(h.newContent ?? '').split('\n');
    lines.splice(s, e - s + 1, ...newLines);
  }
  return lines.join('\n');
}

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
      await ctx.ledger.applyTextChange(uri, content);
      return JSON.stringify({ ok: true, path: abs, message: '已写入并进入可撤销批次' });
    }
    if (call.name === 'apply_patch') {
      const abs = resolvePath(String(call.args.path), root);
      const raw = call.args.hunks ?? call.args.patches;
      if (!Array.isArray(raw)) {
        return JSON.stringify({ ok: false, error: 'apply_patch 需要 hunks: [{ startLine, endLine, newContent }]' });
      }
      const hunks: LineHunk[] = [];
      for (const x of raw) {
        if (!x || typeof x !== 'object') continue;
        const o = x as Record<string, unknown>;
        hunks.push({
          startLine: Number(o.startLine ?? o.start ?? 0),
          endLine: Number(o.endLine ?? o.end ?? o.startLine ?? 0),
          newContent: String(o.newContent ?? o.content ?? ''),
        });
      }
      if (!hunks.length) return JSON.stringify({ ok: false, error: 'hunks 为空' });
      const cur = await readText(abs);
      const next = applyLinePatches(cur, hunks);
      await ctx.ledger.applyTextChange(vscode.Uri.file(abs), next);
      return JSON.stringify({ ok: true, path: abs, message: '已按行补丁写入并进入可撤销批次' });
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
