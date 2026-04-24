import * as vscode from 'vscode';
import { ChatViewProvider } from './chat/chatViewProvider';
import { SessionStore } from './core/sessionStore';
import { SettingsStore } from './core/settingsStore';
import { SecretsService } from './core/secretsService';
export async function activate(context: vscode.ExtensionContext) {
  const sessions = new SessionStore(context);
  await sessions.init();
  const settings = new SettingsStore(context);
  const secrets = new SecretsService(context.secrets);

  const provider = new ChatViewProvider(context, sessions, settings, secrets);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider));

  context.subscriptions.push(
    vscode.commands.registerCommand('qingcoder.openChat', async () => {
      await vscode.commands.executeCommand('qingcoder.chatView.focus');
    })
  );
  let active = settings.getActiveSessionId();
  if (!active) {
    const rec = await sessions.createSession(settings.getMode());
    await settings.setActiveSessionId(rec.id);
    active = rec.id;
  }
}

export function deactivate() {
  /* MCP 等资源由 ChatViewProvider / shutdownMcp 在重载路径时关闭 */
}
