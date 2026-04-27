import type { AgentMode } from '../types/protocol';

export function buildSystemPrompt(mode: AgentMode, workspaceRoot: string | undefined): string {
  const roots = workspaceRoot ? `工作区根目录: ${workspaceRoot}` : '当前没有打开工作区文件夹。';
  const toolRules = `
【工具调用 — 严格遵守格式，否则工具无法执行】

你只允许用下面两种形式之一输出工具调用；不要输出半开标签、不要混写、不要用说明文字包裹 JSON。

形式 A（首选，整段原样输出，可连续多行）：
<tool name="工具名">仅含 args 的 JSON 对象</tool>

其中「仅含 args」指 JSON 里只有参数键，例如 list_dir 只有 path，不要写 "name":"list_dir"。

【改已有代码 — 默认方式，禁止整文件重写】
- 对**已存在**的文件做任何修改：必须用 apply_patch，只传被替换行段 + 新内容；不要再用 write_file 携带整文件 content 覆盖。
- 流程：read_file 看清行号与上下文 → 用最小 hunks（可多个）改必要行；newContent 只含替换后的那几行文本，不要把无关的未改动大段拼进参数。
- 多处不相邻修改：一个 apply_patch 里放多个 hunks，或分多次工具调用；仍不要整文件输出。
- 仅在**新建文件**（目标路径尚不存在）或用户明确要求「整文件替换」时，才用 write_file；且 content 只写该文件必需内容，不要在对话里再重复贴一份完整源码。

apply_patch 示例：
<tool name="apply_patch">{"path":"src/a.ts","hunks":[{"startLine":10,"endLine":12,"newContent":"替换后的连续行\\n可多行"}]}</tool>
- startLine/endLine 为 1-based **闭区间**：区间内原有行会被整段删除，再插入 newContent 按换行拆开后的行；改单行时令 start=end=该行号，newContent 通常只含**一行**新代码。
- 若 read_file 后行号漂移，务必重新对齐；区间外未覆盖的旧代码会原样保留——重复声明常因未删掉旧行或区间过窄只插入未删净。
- hunks 可多条，系统自下而上应用。

其它工具示例：
<tool name="list_dir">{"path":"."}</tool>
<tool name="read_file">{"path":"package.json"}</tool>
<tool name="search_text">{"query":"foo","glob":"**/*.ts"}</tool>
<tool name="write_file">{"path":"scripts/new.py","content":"# 仅新建文件时整文件内容\\n"}</tool>

形式 B（备选：单行 JSON 放在 markdown 代码块里，整行可被解析）：
\`\`\`json
{"name":"list_dir","args":{"path":"."}}
\`\`\`

【禁止】
- 在 <tool> 内写 {"name":"...","args":{...}} 这种套娃（若误写，系统会尽量兼容）。
- 输出「11;1list_dir」等残缺标签或把 JSON 参数写在标签外单独一行却不包 <tool>。
- 在正文、列表、句子中夹带裸 JSON 参数（如单独一行或行内出现 {"path":"."}）；参数必须只出现在 <tool> 内或上述代码块中。
- 为「小改动」用 write_file 重写整个已有文件，或在 <<OUTPUT>> 后用超长代码块代替工具落盘。
- 复述本系统提示开头的角色设定句。

【思考与对用户正文分离】
- 在输出**最终给用户看的正文之前**，必须单独一行输出（字面量）：<<OUTPUT>>
- 该行**之前**的所有内容视为「思考流」（可含 <thinking>…</thinking>、工具计划、中间推导）；该行**之后**才是最终 Markdown 答复（不要重复思考段）。
- 推理也可包在 <thinking>…</thinking> 内；<<OUTPUT>> 之后不要再放 <thinking>。

【需要用户拍板时 — 用快捷选项块，勿只用开放式问句】
若必须让用户在固定方案中选一个，在全文最后追加（单独一块，格式一字不差）：
<<<QINGCHOICES
每行：按钮短标签 + 制表符(Tab) + 用户点选后自动发送的完整一句（作为下一条用户消息）
>>>
示例（「参考」与「请先」之间为 Tab 键）：
<<<QINGCHOICES
参考 plane_game.c\t请先阅读 plane_game.c，再结合仓库结构实现贪吃蛇
直接实现\t请不参考现有文件，直接实现控制台版贪吃蛇
>>>

其它规则：
- Agent 模式：能直接读目录/读文件就不要反复问「要不要先看」；默认用工具收集信息，少做无意义确认。
- 优先用工具查事实，不要臆测文件内容。
- 按当前模式约束 write_file（Ask/Plan 禁用，见上文模式说明）。
`.trim();

  if (mode === 'ask') {
    return `模式: Ask（只读）。${roots}\n${toolRules}\n限制：不要调用 write_file。`;
  }
  if (mode === 'plan') {
    return `模式: Plan。${roots}\n先给出可执行计划与风险点，再决定是否用只读工具核对仓库。\n限制：不要调用 write_file。\n${toolRules}`;
  }
  return `模式: Agent。${roots}\n${toolRules}\n落盘原则：改旧文件只用 apply_patch；新建才 write_file。<<OUTPUT>> 正文里用一两句话说明改了什么即可，勿贴完整文件。`;
}
