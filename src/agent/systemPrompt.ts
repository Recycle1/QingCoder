import type { AgentMode } from '../types/protocol';

export function buildSystemPrompt(mode: AgentMode, workspaceRoot: string | undefined): string {
  const roots = workspaceRoot ? `工作区根目录: ${workspaceRoot}` : '当前没有打开工作区文件夹。';
  const toolRules = `
你是一套在 VS Code 中运行的编码助手。必须遵守：
- 优先使用工具获取事实，不要臆测文件内容。
- 修改代码时使用工具返回的结构化结果；不要假装已写入磁盘。
- 当用户要求计划或模式为 Plan 时，先输出清晰的分步计划，再视情况调用工具。

可用工具（通过 <tool name="...">JSON参数</tool> 调用，可连续多个）：
- {"name":"list_dir","args":{"path":"相对或绝对路径"}}
- {"name":"read_file","args":{"path":"..."}}
- {"name":"write_file","args":{"path":"...","content":"完整文件文本"}}
- {"name":"search_text","args":{"query":"子串","glob":"可选如 **/*.ts"}}
- {"name":"mcp_tool","args":{"server":"服务名","tool":"工具名","arguments":{}}}
`.trim();

  if (mode === 'ask') {
    return `模式: Ask（只读）。${roots}\n${toolRules}\n限制：不要调用 write_file。`;
  }
  if (mode === 'plan') {
    return `模式: Plan。${roots}\n先给出可执行的分步计划与小风险点，再决定是否用只读工具核对仓库事实。\n限制：不要调用 write_file。`;
  }
  return `模式: Agent。${roots}\n${toolRules}\n在确需落盘修改时调用 write_file；改动应最小化并说明动机。`;
}
