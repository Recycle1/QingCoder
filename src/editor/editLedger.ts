import * as vscode from 'vscode';
import { diffLines, structuredPatch } from 'diff';
import type { ChangeHighlighter } from './highlights';
import type { SnapshotDocumentProvider } from './reviewDocuments';
import { openReviewDiffs } from './reviewDocuments';

export type FilePendingState = {
  /** 本批次第一次触碰该文件时磁盘上的全文 */
  originBaseline: string;
  /** 每次工具写入：写入前全文 → 写入后全文，用于撤销上一步 / 保留上一步 */
  stack: { id: string; before: string; after: string }[];
};

export class EditLedger {
  /** 当前待确认批次：路径 → 状态 */
  private current: Map<string, FilePendingState> | null = null;

  constructor(
    private readonly highlighter: ChangeHighlighter,
    private readonly snapshots: SnapshotDocumentProvider
  ) {}

  private ensureMap(): Map<string, FilePendingState> {
    if (!this.current) this.current = new Map();
    return this.current;
  }

  getPendingFiles(): string[] {
    if (!this.current) return [];
    return [...this.current.keys()];
  }

  getFileState(fsPath: string): FilePendingState | undefined {
    return this.current?.get(fsPath);
  }

  hasPending(): boolean {
    return !!this.current && this.current.size > 0;
  }

  private async readFileUtf8(uri: vscode.Uri): Promise<string> {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      return doc.getText();
    } catch {
      try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        return '';
      }
    }
  }

  /** 将磁盘文件替换为 newText，并记录一步可撤销栈 */
  async applyTextChange(uri: vscode.Uri, newText: string): Promise<void> {
    const fsPath = uri.fsPath;
    const before = await this.readFileUtf8(uri);
    const map = this.ensureMap();
    let st = map.get(fsPath);
    if (!st) {
      st = { originBaseline: before, stack: [] };
      map.set(fsPath, st);
    }
    const after = newText;
    st.stack.push({ id: `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, before, after });
    const enc = new TextEncoder();
    await vscode.workspace.fs.writeFile(uri, enc.encode(after));
    await this.highlighter.refreshFile(uri, before, after);
  }

  /** 撤销该文件「最后一次」工具写入（栈顶） */
  async undoLastPatch(fsPath: string): Promise<void> {
    const map = this.current;
    const st = map?.get(fsPath);
    if (!st?.stack.length) return;
    const uri = vscode.Uri.file(fsPath);
    const op = st.stack.pop()!;
    const now = await this.readFileUtf8(uri);
    const enc = new TextEncoder();
    await vscode.workspace.fs.writeFile(uri, enc.encode(op.before));
    if (st.stack.length === 0) {
      const cur2 = await this.readFileUtf8(uri);
      if (cur2 === st.originBaseline) {
        map!.delete(fsPath);
        if (map!.size === 0) this.current = null;
        await this.highlighter.clearFile(uri);
        return;
      }
    }
    const cur = await this.readFileUtf8(uri);
    await this.highlighter.refreshFile(uri, st.originBaseline, cur);
  }

  async keepAll(): Promise<void> {
    this.current = null;
    await this.highlighter.clearAll();
  }

  async keepFile(fsPath: string): Promise<void> {
    if (!this.current) return;
    this.current.delete(fsPath);
    if (this.current.size === 0) this.current = null;
    await this.highlighter.clearFile(vscode.Uri.file(fsPath));
  }

  async undoAll(): Promise<void> {
    const map = this.current;
    if (!map) return;
    const enc = new TextEncoder();
    for (const [fsPath, st] of map) {
      await vscode.workspace.fs.writeFile(vscode.Uri.file(fsPath), enc.encode(st.originBaseline));
    }
    this.current = null;
    await this.highlighter.clearAll();
  }

  async undoFile(fsPath: string): Promise<void> {
    const map = this.current;
    const st = map?.get(fsPath);
    if (!st) return;
    const enc = new TextEncoder();
    await vscode.workspace.fs.writeFile(vscode.Uri.file(fsPath), enc.encode(st.originBaseline));
    map!.delete(fsPath);
    if (map!.size === 0) this.current = null;
    await this.highlighter.clearFile(vscode.Uri.file(fsPath));
  }

  async reviewDiff(): Promise<void> {
    if (!this.current) {
      void vscode.window.showInformationMessage('当前没有待审阅的改动批次');
      return;
    }
    const pairs: { fsPath: string; oldText: string }[] = [];
    for (const [fsPath, st] of this.current) {
      pairs.push({ fsPath, oldText: st.originBaseline });
    }
    await openReviewDiffs(this.snapshots, pairs);
  }

  /** 与 Cursor 类似：相对批次基线的增删行数、hunk 数、栈深度 */
  async getPendingLineStats(): Promise<
    { path: string; added: number; removed: number; hunkCount: number; stackDepth: number }[]
  > {
    if (!this.current) return [];
    const out: { path: string; added: number; removed: number; hunkCount: number; stackDepth: number }[] = [];
    for (const [fsPath, st] of this.current) {
      let newText = '';
      try {
        newText = await this.readFileUtf8(vscode.Uri.file(fsPath));
      } catch {
        newText = '';
      }
      const { added, removed } = countLineDelta(st.originBaseline, newText);
      const hunkCount = countStructuredHunks(st.originBaseline, newText);
      out.push({ path: fsPath, added, removed, hunkCount, stackDepth: st.stack.length });
    }
    return out;
  }
}

export function countStructuredHunks(oldStr: string, newStr: string): number {
  try {
    const p = structuredPatch('old', 'new', oldStr, newStr, '', '', { context: 2 });
    return p?.hunks?.length ?? 0;
  } catch {
    return 0;
  }
}

export function computeAddedLineNumbers(oldText: string, newText: string): number[] {
  const parts = diffLines(oldText, newText);
  const added: number[] = [];
  let lineNo = 1;
  for (const p of parts) {
    const count = p.count ?? 0;
    if (p.added) {
      for (let i = 0; i < count; i++) added.push(lineNo + i);
      lineNo += count;
    } else if (!p.removed) {
      lineNo += count;
    }
  }
  return added;
}

export function countLineDelta(oldText: string, newText: string): { added: number; removed: number } {
  const parts = diffLines(oldText, newText);
  let added = 0;
  let removed = 0;
  for (const p of parts) {
    const n = typeof p.count === 'number' ? p.count : p.value ? p.value.split('\n').length : 0;
    if (p.added) added += n;
    else if (p.removed) removed += n;
  }
  return { added, removed };
}
