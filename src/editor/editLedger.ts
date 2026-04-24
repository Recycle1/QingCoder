import * as vscode from 'vscode';
import { diffLines } from 'diff';
import type { ChangeHighlighter } from './highlights';
import type { SnapshotDocumentProvider } from './reviewDocuments';
import { openReviewDiffs } from './reviewDocuments';

export type BatchSnapshot = {
  id: string;
  /** fsPath -> previous utf8 text (可能为空串表示新建前不存在) */
  files: Map<string, string>;
};

export class EditLedger {
  private current: BatchSnapshot | null = null;
  private readonly batches: BatchSnapshot[] = [];

  constructor(
    private readonly highlighter: ChangeHighlighter,
    private readonly snapshots: SnapshotDocumentProvider
  ) {}

  getPendingFiles(): string[] {
    if (!this.current) return [];
    return [...this.current.files.keys()];
  }

  hasPending(): boolean {
    return !!this.current && this.current.files.size > 0;
  }

  private ensureBatch(): BatchSnapshot {
    if (!this.current) {
      this.current = { id: `b_${Date.now()}`, files: new Map() };
      this.batches.push(this.current);
    }
    return this.current;
  }

  async applyFullFileWrite(uri: vscode.Uri, newText: string): Promise<void> {
    const fsPath = uri.fsPath;
    let previous = '';
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      previous = doc.getText();
    } catch {
      try {
        previous = (await vscode.workspace.fs.readFile(uri)).toString();
      } catch {
        previous = '';
      }
    }
    const batch = this.ensureBatch();
    if (!batch.files.has(fsPath)) {
      batch.files.set(fsPath, previous);
    }
    const enc = new TextEncoder();
    await vscode.workspace.fs.writeFile(uri, enc.encode(newText));
    await this.highlighter.refreshFile(uri, previous, newText);
  }

  async keepAll(): Promise<void> {
    this.current = null;
    await this.highlighter.clearAll();
  }

  async keepFile(fsPath: string): Promise<void> {
    if (!this.current) return;
    this.current.files.delete(fsPath);
    if (this.current.files.size === 0) this.current = null;
    await this.highlighter.clearFile(vscode.Uri.file(fsPath));
  }

  async undoAll(): Promise<void> {
    const batch = this.current;
    if (!batch) return;
    const enc = new TextEncoder();
    for (const [fsPath, oldText] of batch.files) {
      await vscode.workspace.fs.writeFile(vscode.Uri.file(fsPath), enc.encode(oldText));
    }
    this.current = null;
    await this.highlighter.clearAll();
  }

  async undoFile(fsPath: string): Promise<void> {
    if (!this.current || !this.current.files.has(fsPath)) return;
    const oldText = this.current.files.get(fsPath) ?? '';
    const enc = new TextEncoder();
    await vscode.workspace.fs.writeFile(vscode.Uri.file(fsPath), enc.encode(oldText));
    this.current.files.delete(fsPath);
    if (this.current.files.size === 0) this.current = null;
    await this.highlighter.clearFile(vscode.Uri.file(fsPath));
  }

  async reviewDiff(): Promise<void> {
    if (!this.current) {
      void vscode.window.showInformationMessage('当前没有待审阅的改动批次');
      return;
    }
    const pairs: { fsPath: string; oldText: string }[] = [];
    for (const [fsPath, oldText] of this.current.files) {
      pairs.push({ fsPath, oldText });
    }
    await openReviewDiffs(this.snapshots, pairs);
  }

  /** 当前待确认批次各文件相对写入前基线的增删行数（读磁盘当前内容） */
  async getPendingLineStats(): Promise<{ path: string; added: number; removed: number }[]> {
    if (!this.current) return [];
    const dec = new TextDecoder();
    const out: { path: string; added: number; removed: number }[] = [];
    for (const [fsPath, oldText] of this.current.files) {
      let newText = '';
      try {
        newText = dec.decode(await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath)));
      } catch {
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
          newText = doc.getText();
        } catch {
          newText = '';
        }
      }
      const { added, removed } = countLineDelta(oldText, newText);
      out.push({ path: fsPath, added, removed });
    }
    return out;
  }
}

/** 计算新增行号（1-based），用于绿色高亮 */
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

/** 按行粒度统计增删行数（与 diffLines 一致） */
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
