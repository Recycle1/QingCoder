import * as vscode from 'vscode';
import type { AgentMode } from '../types/protocol';
import type { ModelProfilePayload } from '../types/protocol';
import { BUILTIN_MODEL_PRESETS } from './modelPresets';

const K_PROFILES = 'qingcoder.modelProfiles';
const K_ACTIVE_PROFILE = 'qingcoder.activeProfileId';
const K_ACTIVE_SESSION = 'qingcoder.activeSessionId';
const K_MODE = 'qingcoder.mode';

export class SettingsStore {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  getModelProfiles(): ModelProfilePayload[] {
    const saved = this.ctx.globalState.get<ModelProfilePayload[]>(K_PROFILES);
    if (saved && saved.length) return saved;
    return BUILTIN_MODEL_PRESETS;
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
}
