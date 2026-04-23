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
  mcp: { loadedPath: string | null; serverCount: number; lastError?: string };
  pending: { hasBatch: boolean; files: string[] };
};

export type SessionSummary = {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
};
