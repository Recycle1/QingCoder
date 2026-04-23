import * as vscode from 'vscode';

/** 为 vscode.diff 左侧提供“修改前快照” */
export class SnapshotDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly snapshots = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider('qingcoder-snapshot', this),
      new vscode.Disposable(() => this._onDidChange.dispose())
    );
  }

  setSnapshot(fsPath: string, text: string): vscode.Uri {
    this.snapshots.set(fsPath, text);
    const uri = vscode.Uri.from({
      scheme: 'qingcoder-snapshot',
      path: '/' + encodeURIComponent(fsPath),
    });
    this._onDidChange.fire(uri);
    return uri;
  }

  clearSnapshot(fsPath: string) {
    this.snapshots.delete(fsPath);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const key = decodeURIComponent(uri.path.replace(/^\//, ''));
    return this.snapshots.get(key) ?? '';
  }
}

export async function openReviewDiffs(
  provider: SnapshotDocumentProvider,
  pairs: { fsPath: string; oldText: string }[]
): Promise<void> {
  for (const p of pairs) {
    const right = vscode.Uri.file(p.fsPath);
    const left = provider.setSnapshot(p.fsPath, p.oldText);
    const title = `QingCoder: ${p.fsPath}`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title);
  }
}
