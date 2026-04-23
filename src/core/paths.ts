import * as path from 'path';
import * as vscode from 'vscode';

export function getWorkspaceMcpCandidates(): string[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const out: string[] = [];
  for (const f of folders) {
    const root = f.uri.fsPath;
    out.push(path.join(root, 'mcp.json'));
    out.push(path.join(root, '.vscode', 'mcp.json'));
  }
  return out;
}
