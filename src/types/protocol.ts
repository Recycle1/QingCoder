export type AgentMode = 'ask' | 'plan' | 'agent';

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'requestState' }
  | { type: 'newSession' }
  | { type: 'switchSession'; sessionId: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'setMode'; mode: AgentMode }
  | { type: 'setModelProfile'; profileId: string }
  | { type: 'saveModelProfile'; profile: ModelProfilePayload }
  | { type: 'saveToken'; profileId: string; token: string }
  | { type: 'clearToken'; profileId: string }
  /** 由扩展主进程弹出 QuickPick / InputBox，勿在 Webview 内用 prompt */
  | { type: 'openTokenWizard' }
  | { type: 'stopGeneration' }
  | { type: 'setModelId'; modelId: string }
  | { type: 'setSidebarOpen'; open: boolean }
  | { type: 'sendMessage'; sessionId: string; text: string; images?: ImagePart[] }
  | { type: 'reloadMcp' }
  | { type: 'keepAll' }
  | { type: 'undoAll' }
  | { type: 'review' }
  | { type: 'keepFile'; path: string }
  | { type: 'undoFile'; path: string };

export type ImagePart = { mime: string; dataBase64: string };

export type ModelProfilePayload = {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
};

export type ChatMessageDto = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  createdAt: number;
  parts: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; imageUrl: { url: string } }
  >;
};

export type HostToWebview =
  | { type: 'state'; payload: UiState }
  | { type: 'sessionMessages'; sessionId: string; messages: ChatMessageDto[] }
  | { type: 'stream'; sessionId: string; id: string; delta: string }
  | { type: 'streamEnd'; sessionId: string; id: string }
  | { type: 'error'; message: string }
  | { type: 'toast'; message: string };

export type UiState = {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  mode: AgentMode;
  modelProfiles: ModelProfilePayload[];
  activeProfileId: string | null;
  /** 当前档案下可选的 model 名称（来自内置目录 + 该档案 defaultModel） */
  availableModels: string[];
  /** 当前档案实际请求 API 时使用的 model */
  selectedModel: string;
  /** 每个档案是否已在 SecretStorage 配置 Token（界面不返回明文） */
  tokenConfigured: Record<string, boolean>;
  mcp: { loadedPath: string | null; serverCount: number; lastError?: string };
  pending: { hasBatch: boolean; files: string[] };
  /** 扩展侧是否正在流式生成（用于显示停止按钮） */
  isStreaming: boolean;
  /** 会话历史侧栏是否展开 */
  sidebarOpen: boolean;
};

export type SessionSummary = {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
};
