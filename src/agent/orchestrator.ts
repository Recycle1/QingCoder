import type { AgentActivityItem, AgentMode } from '../types/protocol';
import type { ChatMessageApi } from '../llm/openaiCompatible';
import { streamChatCompletion } from '../llm/openaiCompatible';
import { buildSystemPrompt } from './systemPrompt';
import { extractToolCalls } from './toolParse';
import { executeTool, mcpToolSummary, type ToolCall } from './toolExecutor';
import type { EditLedger } from '../editor/editLedger';
import type { LoadedMcp } from '../mcp/mcpHost';

let activitySeq = 0;
function nextActivityId(): string {
  return `act_${Date.now()}_${++activitySeq}`;
}

function toolArgsSummary(c: ToolCall): string {
  const a = c.args;
  if (c.name === 'write_file' || c.name === 'read_file') return String(a.path ?? '');
  if (c.name === 'list_dir') return String(a.path ?? '.');
  if (c.name === 'search_text') {
    const q = String(a.query ?? '');
    const g = String(a.glob ?? '');
    return [q, g].filter(Boolean).join(' · ');
  }
  if (c.name === 'mcp_tool') {
    const name = (a as { name?: string; tool?: string }).name ?? (a as { tool?: string }).tool;
    return name ? String(name) : '';
  }
  return '';
}

function shortenActivityText(s: string, max = 140): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function parseToolOk(out: string): boolean {
  try {
    const j = JSON.parse(out) as { ok?: boolean };
    return j?.ok !== false;
  } catch {
    return true;
  }
}

export type OrchestratorDeps = {
  mode: AgentMode;
  model: string;
  baseUrl: string;
  apiKey: string;
  workspaceRoot: string | undefined;
  ledger: EditLedger;
  mcp: LoadedMcp | null;
};

export async function runAgentTurn(
  deps: OrchestratorDeps,
  history: ChatMessageApi[],
  signal: AbortSignal,
  onDelta: (s: string) => void,
  onActivity?: (item: AgentActivityItem) => void
): Promise<string> {
  const sys = `${buildSystemPrompt(deps.mode, deps.workspaceRoot)}\n\n${mcpToolSummary(deps.mcp)}`;
  const messages: ChatMessageApi[] = [{ role: 'system', content: sys }, ...history];

  let assistant = '';
  try {
    for await (const d of streamChatCompletion({
      baseUrl: deps.baseUrl,
      apiKey: deps.apiKey,
      model: deps.model,
      messages,
      signal,
    })) {
      assistant += d;
      onDelta(d);
    }
  } catch (e) {
    if (signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
      return assistant;
    }
    throw e;
  }

  const { calls } = extractToolCalls(assistant);
  const allowed = calls.filter((c) => deps.mode === 'agent' || c.name !== 'write_file');
  if (!allowed.length) {
    return assistant;
  }

  onActivity?.({
    id: nextActivityId(),
    at: Date.now(),
    kind: 'tools_detected',
    detail: `将执行 ${allowed.length} 个工具：${allowed.map((c) => c.name).join('、')}`,
  });

  // 简化 Agent 回路：执行一轮工具后继续一次模型总结（不无限递归）
  const toolOutputs: string[] = [];
  for (const c of allowed) {
    if (signal.aborted) return assistant;
    const summary = toolArgsSummary(c as ToolCall);
    onActivity?.({
      id: nextActivityId(),
      at: Date.now(),
      kind: 'tool_running',
      toolName: c.name,
      detail: summary || undefined,
    });
    const out = await executeTool(c as ToolCall, { root: deps.workspaceRoot, ledger: deps.ledger, mcp: deps.mcp });
    onActivity?.({
      id: nextActivityId(),
      at: Date.now(),
      kind: 'tool_done',
      toolName: c.name,
      detail: shortenActivityText(out),
      ok: parseToolOk(out),
    });
    toolOutputs.push(`工具 ${c.name} 输出: ${out}`);
  }

  onActivity?.({
    id: nextActivityId(),
    at: Date.now(),
    kind: 'followup_model',
    detail: '正在根据工具结果生成摘要…',
  });

  const follow: ChatMessageApi[] = [
    ...messages,
    { role: 'assistant', content: assistant },
    { role: 'user', content: `工具执行结果：\n${toolOutputs.join('\n')}\n请用简短中文总结结果与后续建议。` },
  ];

  let second = '';
  try {
    for await (const d of streamChatCompletion({
      baseUrl: deps.baseUrl,
      apiKey: deps.apiKey,
      model: deps.model,
      messages: follow,
      signal,
    })) {
      second += d;
      onDelta(d);
    }
  } catch (e) {
    if (signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
      return `${assistant}\n\n${second}`.trimEnd();
    }
    throw e;
  }
  return `${assistant}\n\n${second}`;
}
