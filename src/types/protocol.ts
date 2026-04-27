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
  | { type: 'undoFile'; path: string }
  | { type: 'openPendingDiff'; path: string }
  | { type: 'undoLastPatch'; path: string };

export type ImagePart = { mime: string; dataBase64: string };

export type ModelProfilePayload = {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
};

export type QuickReplyDto = { label: string; payload: string };

export type ChatMessageDto = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  createdAt: number;
  parts: Array<
    | { type: 'text'; text: string }
    | { type: 'thinking'; text: string }
    | { type: 'tool_trace'; name: string; body: string }
    | { type: 'tool_result'; name: string; output: string }
    | { type: 'image_url'; imageUrl: { url: string } }
  >;
  quickReplies?: QuickReplyDto[];
};

/** Agent 回合内工具执行等活动，用于 Webview「执行过程」面板 */
export type AgentActivityKind =
  | 'tools_detected'
  | 'tool_running'
  | 'tool_done'
  | 'followup_model';

export type AgentActivityItem = {
  id: string;
  at: number;
  kind: AgentActivityKind;
  toolName?: string;
  detail?: string;
  ok?: boolean;
  /** write_file / apply_patch 后磁盘文件片段预览 */
  snippetPath?: string;
  snippetText?: string;
};

/** 待确认批次中单个文件相对批次开始时的增删行数 */
export type PendingFileLineStat = {
  path: string;
  added: number;
  removed: number;
  /** structuredPatch 的 hunk 数，便于与 Cursor 对照 */
  hunkCount: number;
  /** 本文件工具写入栈深度，可「撤销上一步」次数 */
  stackDepth: number;
};

export type HostToWebview =
  | { type: 'state'; payload: UiState }
  | { type: 'sessionMessages'; sessionId: string; messages: ChatMessageDto[] }
  | { type: 'stream'; sessionId: string; id: string; delta: string }
  | { type: 'streamEnd'; sessionId: string; id: string }
  | { type: 'agentActivityClear'; sessionId: string }
  | { type: 'agentActivity'; sessionId: string; item: AgentActivityItem }
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
  pending: { hasBatch: boolean; files: PendingFileLineStat[] };
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
