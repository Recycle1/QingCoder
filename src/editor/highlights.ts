import * as vscode from 'vscode';
import { computeAddedLineNumbers } from './editLedger';

export class ChangeHighlighter {
  private readonly addedDecorationType: vscode.TextEditorDecorationType;
  private readonly removedLineDecorationType: vscode.TextEditorDecorationType;
  private readonly map = new Map<string, { added: vscode.Range[]; removed: vscode.Range[] }>();

  constructor() {
    this.addedDecorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    });
    this.removedLineDecorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    });
  }

  dispose() {
    this.addedDecorationType.dispose();
    this.removedLineDecorationType.dispose();
  }

  private key(uri: vscode.Uri) {
    return uri.fsPath;
  }

  async refreshFile(uri: vscode.Uri, oldText: string, newText: string): Promise<void> {
    const addedLines = computeAddedLineNumbers(oldText, newText);
    const added: vscode.Range[] = addedLines.map((ln) => {
      const line = Math.max(0, ln - 1);
      return new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
    });
    // 删除行无法在落盘后的单文件中展示原文；用首处删除附近的“提示行”不精确。
    // 这里用旧文本中存在但新文本中整段删除的近似：标记旧文件最后一处连续删除的起始行映射到新文件行号较复杂，MVP 略过红色行内嵌，仅依赖 Review diff。
    const removed: vscode.Range[] = [];
    this.map.set(this.key(uri), { added, removed });
    this.applyToVisibleEditors(uri);
  }

  async clearFile(uri: vscode.Uri): Promise<void> {
    this.map.delete(this.key(uri));
    this.applyToVisibleEditors(uri);
  }

  async clearAll(): Promise<void> {
    this.map.clear();
    for (const ed of vscode.window.visibleTextEditors) {
      ed.setDecorations(this.addedDecorationType, []);
      ed.setDecorations(this.removedLineDecorationType, []);
    }
  }

  private applyToVisibleEditors(uri: vscode.Uri) {
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.fsPath !== uri.fsPath) continue;
      const v = this.map.get(this.key(uri));
      ed.setDecorations(this.addedDecorationType, v?.added ?? []);
      ed.setDecorations(this.removedLineDecorationType, v?.removed ?? []);
    }
  }

  refreshVisible() {
    for (const ed of vscode.window.visibleTextEditors) {
      const v = this.map.get(this.key(ed.document.uri));
      ed.setDecorations(this.addedDecorationType, v?.added ?? []);
      ed.setDecorations(this.removedLineDecorationType, v?.removed ?? []);
    }
  }
}
