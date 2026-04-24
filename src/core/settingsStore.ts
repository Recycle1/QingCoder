import * as vscode from 'vscode';
import type { AgentMode } from '../types/protocol';
import type { ModelProfilePayload } from '../types/protocol';

const K_PROFILES = 'qingcoder.modelProfiles';
const K_ACTIVE_PROFILE = 'qingcoder.activeProfileId';
const K_ACTIVE_SESSION = 'qingcoder.activeSessionId';
const K_MODE = 'qingcoder.mode';
/** profileId -> 用户选择的 API model 名 */
const K_MODEL_ID_BY_PROFILE = 'qingcoder.modelIdByProfile';
const K_CHAT_SIDEBAR_OPEN = 'qingcoder.chatSidebarOpen';

export class SettingsStore {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  getModelIdForProfile(profileId: string, fallback: string): string {
    const map = this.ctx.globalState.get<Record<string, string>>(K_MODEL_ID_BY_PROFILE) ?? {};
    const v = map[profileId];
    return v && v.trim() ? v.trim() : fallback;
  }

  async setModelIdForProfile(profileId: string, modelId: string): Promise<void> {
    const map = { ...(this.ctx.globalState.get<Record<string, string>>(K_MODEL_ID_BY_PROFILE) ?? {}) };
    map[profileId] = modelId.trim();
    await this.ctx.globalState.update(K_MODEL_ID_BY_PROFILE, map);
  }

  /** 仅 globalState 中的覆盖层（由 UI「保存档案」写入）；与内置合并见 resolveModelProfiles */
  getStoredProfileOverrides(): ModelProfilePayload[] | undefined {
    const saved = this.ctx.globalState.get<ModelProfilePayload[]>(K_PROFILES);
    return saved && saved.length ? saved : undefined;
  }

  async setModelProfiles(profiles: ModelProfilePayload[]): Promise<void> {
    await this.ctx.globalState.update(K_PROFILES, profiles);
  }

  getActiveProfileId(): string | null {
    return this.ctx.globalState.get<string | null>(K_ACTIVE_PROFILE) ?? 'openai';
  }

  async setActiveProfileId(id: string | null): Promise<void> {
    await this.ctx.globalState.update(K_ACTIVE_PROFILE, id);
  }

  getActiveSessionId(): string | null {
    return this.ctx.globalState.get<string | null>(K_ACTIVE_SESSION) ?? null;
  }

  async setActiveSessionId(id: string | null): Promise<void> {
    await this.ctx.globalState.update(K_ACTIVE_SESSION, id);
  }

  getMode(): AgentMode {
    return (this.ctx.globalState.get<AgentMode>(K_MODE) ?? 'agent') as AgentMode;
  }

  async setMode(mode: AgentMode): Promise<void> {
    await this.ctx.globalState.update(K_MODE, mode);
  }

  /** 默认收起，主区域以聊天为主；用户用 «/» 展开会话列表 */
  getChatSidebarOpen(): boolean {
    return this.ctx.globalState.get<boolean>(K_CHAT_SIDEBAR_OPEN) === true;
  }

  async setChatSidebarOpen(open: boolean): Promise<void> {
    await this.ctx.globalState.update(K_CHAT_SIDEBAR_OPEN, open);
  }
}
