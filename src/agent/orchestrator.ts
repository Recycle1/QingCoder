import type { AgentMode } from '../types/protocol';
import type { ChatMessageApi } from '../llm/openaiCompatible';
import { streamChatCompletion } from '../llm/openaiCompatible';
import { buildSystemPrompt } from './systemPrompt';
import { extractToolCalls } from './toolParse';
import { executeTool, mcpToolSummary, type ToolCall } from './toolExecutor';
import type { EditLedger } from '../editor/editLedger';
import type { LoadedMcp } from '../mcp/mcpHost';

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
  onDelta: (s: string) => void
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

  // 简化 Agent 回路：执行一轮工具后继续一次模型总结（不无限递归）
  const toolOutputs: string[] = [];
  for (const c of allowed) {
    if (signal.aborted) return assistant;
    const out = await executeTool(c as ToolCall, { root: deps.workspaceRoot, ledger: deps.ledger, mcp: deps.mcp });
    toolOutputs.push(`工具 ${c.name} 输出: ${out}`);
  }

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
