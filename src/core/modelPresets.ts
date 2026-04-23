import type { ModelProfilePayload } from '../types/protocol';

/** 非敏感：仅预设名称与默认端点；密钥走 SecretStorage */
export const BUILTIN_MODEL_PRESETS: ModelProfilePayload[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
  },
  {
    id: 'azure',
    label: 'Azure OpenAI（自定义 Base URL）',
    baseUrl: 'https://YOUR_RESOURCE.openai.azure.com/openai/deployments/YOUR_DEPLOYMENT',
    defaultModel: 'gpt-4o',
  },
  {
    id: 'custom',
    label: '自定义 OpenAI 兼容',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3',
  },
];
