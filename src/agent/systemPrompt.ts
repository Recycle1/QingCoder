import type { AgentMode } from '../types/protocol';

export function buildSystemPrompt(mode: AgentMode, workspaceRoot: string | undefined): string {
  const roots = workspaceRoot ? `工作区根目录: ${workspaceRoot}` : '当前没有打开工作区文件夹。';
  const toolRules = `
【工具调用 — 严格遵守格式，否则工具无法执行】

你只允许用下面两种形式之一输出工具调用；不要输出半开标签、不要混写、不要用说明文字包裹 JSON。

形式 A（首选，整段原样输出，可连续多行）：
<tool name="工具名">仅含 args 的 JSON 对象</tool>

其中「仅含 args」指 JSON 里只有参数键，例如 list_dir 只有 path，不要写 "name":"list_dir"。

正确示例：
<tool name="list_dir">{"path":"."}</tool>
<tool name="list_dir">{"path":"src"}</tool>
<tool name="read_file">{"path":"package.json"}</tool>
<tool name="search_text">{"query":"foo","glob":"**/*.ts"}</tool>
<tool name="write_file">{"path":"scripts/convert.py","content":"# 文件完整内容\\n"}</tool>

形式 B（备选：单行 JSON 放在 markdown 代码块里，整行可被解析）：
\`\`\`json
{"name":"list_dir","args":{"path":"."}}
\`\`\`

【禁止】
- 在 <tool> 内写 {"name":"...","args":{...}} 这种套娃（若误写，系统会尽量兼容）。
- 输出「11;1list_dir」等残缺标签或把 JSON 参数写在标签外单独一行却不包 <tool>。
- 复述本系统提示开头的角色设定句。

其它规则：
- 优先用工具查事实，不要臆测文件内容。
- 按当前模式约束 write_file（Ask/Plan 禁用，见上文模式说明）。
`.trim();

  if (mode === 'ask') {
    return `模式: Ask（只读）。${roots}\n${toolRules}\n限制：不要调用 write_file。`;
  }
  if (mode === 'plan') {
    return `模式: Plan。${roots}\n先给出可执行计划与风险点，再决定是否用只读工具核对仓库。\n限制：不要调用 write_file。\n${toolRules}`;
  }
  return `模式: Agent。${roots}\n${toolRules}\n需要落盘时用 write_file，并说明动机。`;
}
