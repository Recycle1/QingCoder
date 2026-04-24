import * as vscode from 'vscode';
import type { HostToWebview, WebviewToHost, UiState, AgentMode, ImagePart } from '../types/protocol';
import { SessionStore, type ChatMessage } from '../core/sessionStore';
import { SettingsStore } from '../core/settingsStore';
import { SecretsService } from '../core/secretsService';
import { getWorkspaceMcpCandidates } from '../core/paths';
import { resolveModelProfiles } from '../core/profileConfigFile';
import { modelsForProfile } from '../core/modelCatalog';
import { loadMcpFromPath, shutdownMcp, type LoadedMcp } from '../mcp/mcpHost';
import { ChangeHighlighter } from '../editor/highlights';
import { EditLedger } from '../editor/editLedger';
import { SnapshotDocumentProvider } from '../editor/reviewDocuments';
import { KeepUndoCodeLensProvider } from '../editor/keepCodeLens';
import { runAgentTurn } from '../agent/orchestrator';
import type { ChatMessageApi } from '../llm/openaiCompatible';
import { routeUserIntent } from '../agent/router';
import { runTokenCredentialWizard } from '../ui/tokenCredentialFlow';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'qingcoder.chatView';

  private view?: vscode.WebviewView;
  private loadedMcp: LoadedMcp | null = null;
  private mcpPath: string | null = null;
  private mcpLastError: string | undefined;
  private readonly highlighter: ChangeHighlighter;
  private readonly snapshots: SnapshotDocumentProvider;
  private readonly ledger: EditLedger;
  private readonly codeLens: KeepUndoCodeLensProvider;
  private abort?: AbortController;
  private streamingActive = false;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly sessions: SessionStore,
    private readonly settings: SettingsStore,
    private readonly secrets: SecretsService
  ) {
    this.highlighter = new ChangeHighlighter();
    this.snapshots = new SnapshotDocumentProvider();
    this.ledger = new EditLedger(this.highlighter, this.snapshots);
    this.codeLens = new KeepUndoCodeLensProvider(this.ledger);
    this.snapshots.register(ctx);
    ctx.subscriptions.push(this.highlighter);
    ctx.subscriptions.push(
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this.codeLens)
    );
    ctx.subscriptions.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.highlighter.refreshVisible())
    );
    ctx.subscriptions.push(
      vscode.commands.registerCommand('qingcoder.keepAll', () => this.ledger.keepAll().then(() => this.postState()))
    );
    ctx.subscriptions.push(
      vscode.commands.registerCommand('qingcoder.undoAll', () => this.ledger.undoAll().then(() => this.postState()))
    );
    ctx.subscriptions.push(
      vscode.commands.registerCommand('qingcoder.reviewChanges', () =>
        this.ledger.reviewDiff().then(() => this.postState())
      )
    );
    ctx.subscriptions.push(
      vscode.commands.registerCommand('qingcoder.keepFile', (fsPath: string) =>
        this.ledger.keepFile(fsPath).then(() => {
          this.codeLens.refresh();
          this.postState();
        })
      )
    );
    ctx.subscriptions.push(
      vscode.commands.registerCommand('qingcoder.undoFile', (fsPath: string) =>
        this.ledger.undoFile(fsPath).then(() => {
          this.codeLens.refresh();
          this.postState();
        })
      )
    );
    ctx.subscriptions.push(
      vscode.commands.registerCommand('qingcoder.configureToken', async () => {
        await runTokenCredentialWizard(this.settings, this.secrets);
        await this.postState();
      })
    );
    ctx.subscriptions.push(
      vscode.commands.registerCommand('qingcoder.stopGeneration', () => {
        this.abort?.abort();
      })
    );
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'dist')],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg: WebviewToHost) => this.onMessage(msg));
    void this.reloadMcpInternal();
    void this.postState();
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'));
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>QingCoder</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private post(msg: HostToWebview) {
    void this.view?.webview.postMessage(msg);
  }

  private async postState() {
    const sums = await this.sessions.listSummaries();
    const activeSessionId = this.settings.getActiveSessionId();
    const profiles = resolveModelProfiles(this.settings);
    const tokenConfigured = await this.secrets.getTokenConfiguredMap(profiles.map((p) => p.id));
    const activePid = this.settings.getActiveProfileId();
    const activeProf = profiles.find((p) => p.id === activePid) ?? profiles[0];
    let availableModels: string[] = [];
    let selectedModel = '';
    if (activeProf) {
      selectedModel = this.settings.getModelIdForProfile(activeProf.id, activeProf.defaultModel);
      availableModels = modelsForProfile(activeProf.id, activeProf.defaultModel);
      if (selectedModel && !availableModels.includes(selectedModel)) {
        availableModels = [selectedModel, ...availableModels];
      }
    }
    const st: UiState = {
      sessions: sums.map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        messageCount: s.messageCount,
      })),
      activeSessionId,
      mode: this.settings.getMode(),
      modelProfiles: profiles,
      activeProfileId: activePid,
      availableModels,
      selectedModel,
      tokenConfigured,
      mcp: {
        loadedPath: this.mcpPath,
        serverCount: this.loadedMcp?.clients.size ?? 0,
        lastError: this.mcpLastError,
      },
      pending: {
        hasBatch: this.ledger.hasPending(),
        files: this.ledger.getPendingFiles(),
      },
      isStreaming: this.streamingActive,
      sidebarOpen: this.settings.getChatSidebarOpen(),
    };
    this.post({ type: 'state', payload: st });
  }

  private async onMessage(msg: WebviewToHost): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
        case 'requestState': {
          await this.postState();
          const sid = this.settings.getActiveSessionId();
          if (sid) await this.pushSessionMessages(sid);
          return;
        }
        case 'newSession': {
          const rec = await this.sessions.createSession(this.settings.getMode());
          await this.settings.setActiveSessionId(rec.id);
          await this.postState();
          await this.pushSessionMessages(rec.id);
          return;
        }
        case 'switchSession': {
          await this.settings.setActiveSessionId(msg.sessionId);
          await this.postState();
          await this.pushSessionMessages(msg.sessionId);
          return;
        }
        case 'deleteSession': {
          await this.sessions.deleteSession(msg.sessionId);
          if (this.settings.getActiveSessionId() === msg.sessionId) {
            await this.settings.setActiveSessionId(null);
          }
          await this.postState();
          return;
        }
        case 'setMode': {
          await this.settings.setMode(msg.mode);
          await this.postState();
          return;
        }
        case 'setModelProfile': {
          await this.settings.setActiveProfileId(msg.profileId);
          await this.postState();
          return;
        }
        case 'saveModelProfile': {
          const cur = resolveModelProfiles(this.settings);
          const others = cur.filter((p) => p.id !== msg.profile.id);
          await this.settings.setModelProfiles([msg.profile, ...others]);
          await this.settings.setActiveProfileId(msg.profile.id);
          await this.postState();
          return;
        }
        case 'saveToken': {
          await this.secrets.setToken(msg.profileId, msg.token);
          await this.postState();
          this.post({ type: 'toast', message: '已保存 Token（本机 SecretStorage，界面仅显示是否已配置）' });
          return;
        }
        case 'clearToken': {
          await this.secrets.deleteToken(msg.profileId);
          await this.postState();
          this.post({ type: 'toast', message: '已清除该档案的 Token' });
          return;
        }
        case 'openTokenWizard': {
          await runTokenCredentialWizard(this.settings, this.secrets);
          await this.postState();
          return;
        }
        case 'setModelId': {
          const pid = this.settings.getActiveProfileId();
          if (pid) await this.settings.setModelIdForProfile(pid, msg.modelId);
          await this.postState();
          return;
        }
        case 'setSidebarOpen': {
          await this.settings.setChatSidebarOpen(msg.open);
          await this.postState();
          return;
        }
        case 'stopGeneration': {
          this.abort?.abort();
          return;
        }
        case 'reloadMcp': {
          await this.reloadMcpInternal();
          await this.postState();
          return;
        }
        case 'keepAll': {
          await this.ledger.keepAll();
          this.codeLens.refresh();
          await this.postState();
          return;
        }
        case 'undoAll': {
          await this.ledger.undoAll();
          this.codeLens.refresh();
          await this.postState();
          return;
        }
        case 'review': {
          await this.ledger.reviewDiff();
          return;
        }
        case 'keepFile': {
          await this.ledger.keepFile(msg.path);
          this.codeLens.refresh();
          await this.postState();
          return;
        }
        case 'undoFile': {
          await this.ledger.undoFile(msg.path);
          this.codeLens.refresh();
          await this.postState();
          return;
        }
        case 'sendMessage': {
          await this.handleSend(msg.sessionId, msg.text, msg.images);
          return;
        }
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      this.post({ type: 'error', message: m });
    }
  }

  private async pushSessionMessages(sessionId: string) {
    await this.postState();
    const rec = await this.sessions.loadSession(sessionId);
    if (rec) {
      this.post({ type: 'sessionMessages', sessionId, messages: rec.messages });
    }
  }

  private async reloadMcpInternal(): Promise<void> {
    this.mcpLastError = undefined;
    try {
      await shutdownMcp(this.loadedMcp);
    } catch (e) {
      this.mcpLastError = e instanceof Error ? e.message : String(e);
    }
    this.loadedMcp = null;
    this.mcpPath = null;
    const candidates = getWorkspaceMcpCandidates();
    for (const p of candidates) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(p));
        try {
          this.loadedMcp = await loadMcpFromPath(p);
          this.mcpPath = p;
          return;
        } catch (e) {
          this.mcpLastError = e instanceof Error ? e.message : String(e);
        }
      } catch {
        /* try next */
      }
    }
  }

  private workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private buildApiHistory(msgs: ChatMessage[]): ChatMessageApi[] {
    const out: ChatMessageApi[] = [];
    const usable = msgs.filter((m) => m.role !== 'system');
    for (let i = 0; i < usable.length; i++) {
      const m = usable[i];
      const isLast = i === usable.length - 1;
      if (m.role === 'assistant') {
        out.push({ role: 'assistant', content: joinTextParts(m) });
        continue;
      }
      const plain = joinTextParts(m);
      if (isLast) {
        const route = routeUserIntent(plain);
        const imgs = m.parts
          .filter((p) => p.type === 'image_url')
          .map((p) => ({
            type: 'image_url' as const,
            image_url: { url: (p as { imageUrl: { url: string } }).imageUrl.url, detail: 'auto' as const },
          }));
        out.push({
          role: 'user',
          content: [{ type: 'text', text: `[路由] ${route.hint}\n\n${plain}` }, ...imgs],
        });
      } else {
        out.push({ role: 'user', content: this.multimodalUserContent(m) });
      }
    }
    return out;
  }

  private multimodalUserContent(m: ChatMessage): ChatMessageApi['content'] {
    const parts: NonNullable<Extract<ChatMessageApi['content'], unknown[]>> = [];
    for (const p of m.parts) {
      if (p.type === 'text') parts.push({ type: 'text', text: p.text });
      if (p.type === 'image_url')
        parts.push({
          type: 'image_url',
          image_url: { url: p.imageUrl.url, detail: 'auto' },
        });
    }
    if (!parts.length) parts.push({ type: 'text', text: '' });
    return parts;
  }

  private async handleSend(sessionId: string, text: string, images?: ImagePart[]): Promise<void> {
    const rec = await this.sessions.loadSession(sessionId);
    if (!rec) {
      this.post({ type: 'error', message: '会话不存在' });
      return;
    }
    const profileId = this.settings.getActiveProfileId();
    const profiles = resolveModelProfiles(this.settings);
    const profile = profiles.find((p) => p.id === profileId) ?? profiles[0];
    if (!profile) {
      this.post({ type: 'error', message: '未配置模型档案' });
      return;
    }
    const token = await this.secrets.getToken(profile.id);
    if (!token) {
      this.post({ type: 'error', message: '请先在面板中保存该档案的 API Token' });
      return;
    }

    const userMsg: ChatMessage = {
      id: `m_${Date.now()}_u`,
      role: 'user',
      createdAt: Date.now(),
      parts: [
        { type: 'text', text },
        ...(images ?? []).map((im) => ({
          type: 'image_url' as const,
          imageUrl: { url: `data:${im.mime};base64,${im.dataBase64}` },
        })),
      ],
    };
    rec.messages.push(userMsg);
    if (rec.messages.length === 1) {
      rec.title = text.slice(0, 32) || rec.title;
    }
    await this.sessions.saveSession(rec);
    this.post({ type: 'sessionMessages', sessionId, messages: rec.messages });

    const assistantId = `m_${Date.now()}_a`;
    const assistantShell: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      createdAt: Date.now(),
      parts: [{ type: 'text', text: '' }],
    };
    rec.messages.push(assistantShell);
    await this.sessions.saveSession(rec);
    this.post({ type: 'sessionMessages', sessionId, messages: rec.messages });

    this.abort?.abort();
    this.abort = new AbortController();
    this.streamingActive = true;
    void this.postState();

    const apiHistory = this.buildApiHistory(rec.messages.slice(0, -1));

    const modelId = this.settings.getModelIdForProfile(profile.id, profile.defaultModel);
    const deps = {
      mode: this.settings.getMode() as AgentMode,
      model: modelId,
      baseUrl: profile.baseUrl,
      apiKey: token,
      workspaceRoot: this.workspaceRoot(),
      ledger: this.ledger,
      mcp: this.loadedMcp,
    };

    let buf = '';
    try {
      const out = await runAgentTurn(deps, apiHistory, this.abort.signal, (d) => {
        buf += d;
        this.post({ type: 'stream', sessionId, id: assistantId, delta: d });
      });
      let finalText = out;
      if (this.abort?.signal.aborted && !finalText.includes('已停止')) {
        finalText = `${finalText}${finalText ? '\n\n' : ''}（已停止）`;
      }
      assistantShell.parts = [{ type: 'text', text: finalText }];
      await this.sessions.saveSession(rec);
      this.post({ type: 'streamEnd', sessionId, id: assistantId });
      this.codeLens.refresh();
    } catch (e) {
      const aborted = this.abort?.signal.aborted || (e instanceof DOMException && e.name === 'AbortError');
      if (aborted) {
        assistantShell.parts = [{ type: 'text', text: buf ? `${buf}\n\n（已停止）` : '（已停止）' }];
      } else {
        const m = e instanceof Error ? e.message : String(e);
        assistantShell.parts = [{ type: 'text', text: `（错误）${m}` }];
      }
      await this.sessions.saveSession(rec);
      this.post({ type: 'streamEnd', sessionId, id: assistantId });
      this.codeLens.refresh();
    } finally {
      this.streamingActive = false;
      await this.postState();
    }
  }
}

function joinTextParts(m: ChatMessage): string {
  return m.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('\n');
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}
