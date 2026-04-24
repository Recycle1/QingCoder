/**
 * 各服务商（profile id）下可选的 API model 名称，供侧栏下拉使用。
 * 实际以各平台文档为准，可按需增删。
 */
export const MODELS_BY_PROFILE_ID: Record<string, string[]> = {
  openai: [
    'gpt-4o-mini',
    'gpt-4o',
    'gpt-4-turbo',
    'gpt-3.5-turbo',
    'o1-mini',
    'o1',
    'o3-mini',
  ],
  siliconflow: [
    'Qwen/Qwen2.5-7B-Instruct',
    'Qwen/Qwen2.5-14B-Instruct',
    'Qwen/Qwen2.5-32B-Instruct',
    'Qwen/Qwen2.5-72B-Instruct',
    'deepseek-ai/DeepSeek-V3',
    'deepseek-ai/DeepSeek-R1',
    'THUDM/glm-4-9b-chat',
    'meta-llama/Meta-Llama-3.1-8B-Instruct',
    'meta-llama/Meta-Llama-3.1-70B-Instruct',
  ],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  azure: ['gpt-4o', 'gpt-4o-mini', 'gpt-4', 'gpt-35-turbo'],
  /** 本地/任意兼容端点：给常用占位名，仍可改 defaultModel 或在 UI 选其它 */
  custom: ['llama3', 'llama3.1', 'mistral', 'mixtral-8x7b', 'qwen2.5', 'phi3'],
};

export function modelsForProfile(profileId: string, defaultModel: string): string[] {
  const list = MODELS_BY_PROFILE_ID[profileId];
  const base = list?.length ? [...list] : [defaultModel];
  if (!base.includes(defaultModel)) base.unshift(defaultModel);
  return [...new Set(base)];
}
