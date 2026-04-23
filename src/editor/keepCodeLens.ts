import * as vscode from 'vscode';
import type { EditLedger } from './editLedger';

export class KeepUndoCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly ledger: EditLedger) {}

  refresh() {
    this.emitter.fire();
  }

  provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.CodeLens[]> {
    const pending = this.ledger.getPendingFiles();
    if (!pending.includes(document.uri.fsPath)) return [];
    const range = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(range, {
        title: 'QingCoder: Keep',
        command: 'qingcoder.keepFile',
        arguments: [document.uri.fsPath],
      }),
      new vscode.CodeLens(range, {
        title: 'QingCoder: Undo',
        command: 'qingcoder.undoFile',
        arguments: [document.uri.fsPath],
      }),
    ];
  }
}
