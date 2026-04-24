import type { ModelProfilePayload } from '../types/protocol';
import { BUILTIN_MODEL_PRESETS } from './modelPresets';
import type { SettingsStore } from './settingsStore';

function mergeById(base: ModelProfilePayload[], overlay: ModelProfilePayload[]): ModelProfilePayload[] {
  const m = new Map(base.map((p) => [p.id, { ...p }]));
  for (const p of overlay) m.set(p.id, { ...p });
  return [...m.values()];
}

/** 内置预设 + globalState 中「保存档案」覆盖（不再读取工作区 qingcoder.json） */
export function resolveModelProfiles(settings: SettingsStore): ModelProfilePayload[] {
  return mergeById(BUILTIN_MODEL_PRESETS, settings.getStoredProfileOverrides() ?? []);
}
