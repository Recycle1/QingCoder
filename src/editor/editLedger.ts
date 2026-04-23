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
