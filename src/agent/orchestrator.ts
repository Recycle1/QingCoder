import * as fs from 'fs/promises';
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
  if (c.name === 'apply_patch') {
    const hunks = a.hunks ?? a.patches;
    return Array.isArray(hunks) ? `${hunks.length} 处行替换` : '';
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

/** 与原先 string 兼容：text 为合并后的助手可见全文；executedTools 供落库后下一轮 API 带上工具回包 */
export type RunAgentTurnResult = {
  text: string;
  executedTools?: { name: string; output: string }[];
};

function allowedToolsFilter(deps: OrchestratorDeps, calls: ToolCall[]): ToolCall[] {
  return calls.filter(
    (c) => deps.mode === 'agent' || (c.name !== 'write_file' && c.name !== 'apply_patch')
  );
}

async function streamAssistant(
  messages: ChatMessageApi[],
  deps: OrchestratorDeps,
  signal: AbortSignal,
  onDelta: (s: string) => void
): Promise<string> {
  let buf = '';
  for await (const d of streamChatCompletion({
    baseUrl: deps.baseUrl,
    apiKey: deps.apiKey,
    model: deps.model,
    messages,
    signal,
  })) {
    buf += d;
    onDelta(d);
  }
  return buf;
}

/** 从某段模型输出里解析并执行工具（第一轮 assistant、第二轮 follow-up 等都要跑） */
async function executeToolsFromModelText(
  segmentLabel: string,
  text: string,
  deps: OrchestratorDeps,
  signal: AbortSignal,
  onActivity?: (item: AgentActivityItem) => void
): Promise<{ toolLines: string[]; executed: { name: string; output: string }[] }> {
  const { calls } = extractToolCalls(text);
  const allowed = allowedToolsFilter(deps, calls);
  const toolLines: string[] = [];
  const executed: { name: string; output: string }[] = [];
  if (!allowed.length) {
    return { toolLines, executed };
  }

  onActivity?.({
    id: nextActivityId(),
    at: Date.now(),
    kind: 'tools_detected',
    detail: `${segmentLabel}将执行 ${allowed.length} 个工具：${allowed.map((c) => c.name).join('、')}`,
  });

  for (const c of allowed) {
    if (signal.aborted) {
      return { toolLines, executed };
    }
    const summary = toolArgsSummary(c as ToolCall);
    onActivity?.({
      id: nextActivityId(),
      at: Date.now(),
      kind: 'tool_running',
      toolName: c.name,
      detail: summary || undefined,
    });
    const out = await executeTool(c as ToolCall, { root: deps.workspaceRoot, ledger: deps.ledger, mcp: deps.mcp });
    executed.push({ name: (c as ToolCall).name, output: out });
    let snippetPath: string | undefined;
    let snippetText: string | undefined;
    try {
      const j = JSON.parse(out) as { ok?: boolean; path?: string };
      if (j.ok && j.path && (c.name === 'write_file' || c.name === 'apply_patch')) {
        snippetPath = j.path;
        snippetText = (await fs.readFile(j.path, 'utf8').catch(() => '')).slice(0, 2400);
      }
    } catch {
      /* ignore */
    }
    onActivity?.({
      id: nextActivityId(),
      at: Date.now(),
      kind: 'tool_done',
      toolName: c.name,
      detail: shortenActivityText(out),
      ok: parseToolOk(out),
      snippetPath,
      snippetText,
    });
    toolLines.push(`工具 ${c.name} 输出: ${out}`);
  }
  return { toolLines, executed };
}

function toolUserMessage(toolLines: string[], round: '1' | '2' | '3'): string {
  const body = toolLines.join('\n');
  if (round === '1') {
    return `工具执行结果：\n${body}\n请用简短中文总结结果与后续建议；用户可见正文中不要输出 <tool>、工具 JSON 或裸参数；不要重复贴出已写入文件的完整源码（改动手已通过工具完成）；推理请放在 <thinking> 内。`;
  }
  if (round === '2') {
    return `第二轮工具执行结果：\n${body}\n若已成功落盘，请一两句中文确认即可；除明确失败外勿再输出 write_file/apply_patch；不要重复贴完整源码。`;
  }
  return `第三轮工具执行结果：\n${body}\n请一句话确认是否已成功；不要再发起任何工具调用。`;
}

export async function runAgentTurn(
  deps: OrchestratorDeps,
  history: ChatMessageApi[],
  signal: AbortSignal,
  onDelta: (s: string) => void,
  onActivity?: (item: AgentActivityItem) => void
): Promise<RunAgentTurnResult> {
  const sys = `${buildSystemPrompt(deps.mode, deps.workspaceRoot)}\n\n${mcpToolSummary(deps.mcp)}`;
  const baseMessages: ChatMessageApi[] = [{ role: 'system', content: sys }, ...history];

  let assistant = '';
  try {
    assistant = await streamAssistant(baseMessages, deps, signal, onDelta);
  } catch (e) {
    if (signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
      return { text: assistant };
    }
    throw e;
  }

  const round1 = await executeToolsFromModelText('第一轮 · ', assistant, deps, signal, onActivity);
  const executedTools: { name: string; output: string }[] = [...round1.executed];

  if (!round1.executed.length) {
    return { text: assistant, executedTools: undefined };
  }

  onActivity?.({
    id: nextActivityId(),
    at: Date.now(),
    kind: 'followup_model',
    detail: '正在根据工具结果生成摘要…',
  });

  const follow1: ChatMessageApi[] = [
    ...baseMessages,
    { role: 'assistant', content: assistant },
    { role: 'user', content: toolUserMessage(round1.toolLines, '1') },
  ];

  let second = '';
  try {
    second = await streamAssistant(follow1, deps, signal, onDelta);
  } catch (e) {
    if (signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
      return { text: `${assistant}\n\n${second}`.trimEnd(), executedTools };
    }
    throw e;
  }

  /** 模型常在「读完文件后的第二段」里才输出 apply_patch；必须再解析执行，否则会只展示工具块不落盘 */
  const round2 = await executeToolsFromModelText('第二轮 · ', second, deps, signal, onActivity);
  executedTools.push(...round2.executed);

  if (!round2.executed.length) {
    return { text: `${assistant}\n\n${second}`.trimEnd(), executedTools };
  }

  onActivity?.({
    id: nextActivityId(),
    at: Date.now(),
    kind: 'followup_model',
    detail: '正在根据第二轮工具结果生成说明…',
  });

  const follow2: ChatMessageApi[] = [
    ...follow1,
    { role: 'assistant', content: second },
    { role: 'user', content: toolUserMessage(round2.toolLines, '2') },
  ];

  let third = '';
  try {
    third = await streamAssistant(follow2, deps, signal, onDelta);
  } catch (e) {
    if (signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
      return { text: `${assistant}\n\n${second}\n\n${third}`.trimEnd(), executedTools };
    }
    throw e;
  }

  const round3 = await executeToolsFromModelText('第三轮 · ', third, deps, signal, onActivity);
  executedTools.push(...round3.executed);

  if (!round3.executed.length) {
    const parts = [assistant, second, third].filter((s) => s.length > 0);
    return { text: parts.join('\n\n').trimEnd(), executedTools };
  }

  onActivity?.({
    id: nextActivityId(),
    at: Date.now(),
    kind: 'followup_model',
    detail: '正在根据第三轮工具结果收束说明…',
  });

  const follow3: ChatMessageApi[] = [
    ...follow2,
    { role: 'assistant', content: third },
    { role: 'user', content: toolUserMessage(round3.toolLines, '3') },
  ];

  let fourth = '';
  try {
    fourth = await streamAssistant(follow3, deps, signal, onDelta);
  } catch (e) {
    if (signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
      return { text: `${assistant}\n\n${second}\n\n${third}\n\n${fourth}`.trimEnd(), executedTools };
    }
    throw e;
  }

  const parts = [assistant, second, third, fourth].filter((s) => s.length > 0);
  return { text: parts.join('\n\n').trimEnd(), executedTools };
}
