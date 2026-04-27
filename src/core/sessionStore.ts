import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentMode } from '../types/protocol';

export type ChatRole = 'user' | 'assistant' | 'system';

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  /** 模型输出中的工具调用片段，与正文分开展示 */
  | { type: 'tool_trace'; name: string; body: string }
  /** 扩展实际执行工具后的 JSON 回包，写入会话供下一轮模型引用（不在模型原文中） */
  | { type: 'tool_result'; name: string; output: string }
  | { type: 'image_url'; imageUrl: { url: string } };

export type QuickReply = { label: string; payload: string };

export type ChatMessage = {
  id: string;
  role: ChatRole;
  createdAt: number;
  parts: ChatContentPart[];
  /** 助手消息：快捷按钮，点击即发送 payload 作为用户消息 */
  quickReplies?: QuickReply[];
};

export type SessionRecord = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  mode: AgentMode;
  messages: ChatMessage[];
};

const SESSIONS_DIR = 'sessions';
const INDEX_FILE = 'index.json';

type IndexFile = {
  sessions: { id: string; title: string; updatedAt: number; messageCount: number }[];
};

function sessionsRoot(ctx: vscode.ExtensionContext): string {
  return path.join(ctx.globalStorageUri.fsPath, SESSIONS_DIR);
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

export class SessionStore {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  private indexPath() {
    return path.join(sessionsRoot(this.ctx), INDEX_FILE);
  }

  private sessionPath(id: string) {
    return path.join(sessionsRoot(this.ctx), `${id}.json`);
  }

  async init(): Promise<void> {
    await ensureDir(sessionsRoot(this.ctx));
    try {
      await fs.access(this.indexPath());
    } catch {
      const empty: IndexFile = { sessions: [] };
      await fs.writeFile(this.indexPath(), JSON.stringify(empty, null, 2), 'utf8');
    }
  }

  async listSummaries(): Promise<IndexFile['sessions']> {
    await this.init();
    const raw = await fs.readFile(this.indexPath(), 'utf8');
    const idx = JSON.parse(raw) as IndexFile;
    return idx.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async loadSession(id: string): Promise<SessionRecord | null> {
    try {
      const raw = await fs.readFile(this.sessionPath(id), 'utf8');
      return JSON.parse(raw) as SessionRecord;
    } catch {
      return null;
    }
  }

  async saveSession(rec: SessionRecord): Promise<void> {
    await this.init();
    rec.updatedAt = Date.now();
    await fs.writeFile(this.sessionPath(rec.id), JSON.stringify(rec, null, 2), 'utf8');
    const idxRaw = await fs.readFile(this.indexPath(), 'utf8');
    const idx = JSON.parse(idxRaw) as IndexFile;
    const others = idx.sessions.filter((s) => s.id !== rec.id);
    idx.sessions = [
      {
        id: rec.id,
        title: rec.title,
        updatedAt: rec.updatedAt,
        messageCount: rec.messages.length,
      },
      ...others,
    ];
    await fs.writeFile(this.indexPath(), JSON.stringify(idx, null, 2), 'utf8');
  }

  async createSession(mode: AgentMode): Promise<SessionRecord> {
    const id = `s_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const rec: SessionRecord = {
      id,
      title: '新会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode,
      messages: [],
    };
    await this.saveSession(rec);
    return rec;
  }

  async deleteSession(id: string): Promise<void> {
    await this.init();
    try {
      await fs.unlink(this.sessionPath(id));
    } catch {
      /* noop */
    }
    const idxRaw = await fs.readFile(this.indexPath(), 'utf8');
    const idx = JSON.parse(idxRaw) as IndexFile;
    idx.sessions = idx.sessions.filter((s) => s.id !== id);
    await fs.writeFile(this.indexPath(), JSON.stringify(idx, null, 2), 'utf8');
  }
}
