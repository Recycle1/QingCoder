import type { ToolCall } from './toolExecutor';

const KNOWN_TOOLS = new Set(['list_dir', 'read_file', 'write_file', 'search_text', 'mcp_tool']);

function dedupeKey(c: ToolCall): string {
  return `${c.name}::${JSON.stringify(c.args)}`;
}

/** 解析 {"name":"x","args":{...}} 单行或多行紧凑 JSON */
function tryParseNameArgsObject(raw: string): ToolCall | null {
  const s = raw.trim();
  if (!s.startsWith('{') || !s.includes('"name"') || !s.includes('"args"')) return null;
  try {
    const o = JSON.parse(s) as { name?: string; args?: unknown };
    if (!o?.name || !KNOWN_TOOLS.has(o.name)) return null;
    if (!o.args || typeof o.args !== 'object' || Array.isArray(o.args)) return null;
    return { name: o.name, args: o.args as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** 从 <tool name="x"> 内 JSON 得到 args：支持纯 args 或误套的 name+args */
function parseInnerToolJson(toolName: string, raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  try {
    const w = JSON.parse(trimmed) as { name?: string; args?: Record<string, unknown> };
    if (w && typeof w.name === 'string' && w.args && typeof w.args === 'object' && !Array.isArray(w.args)) {
      if (w.name === toolName) return w.args;
    }
    const plain = JSON.parse(trimmed) as Record<string, unknown>;
    if (plain && typeof plain === 'object' && !Array.isArray(plain)) {
      if ('name' in plain && 'args' in plain && typeof plain.args === 'object') {
        return (plain.args as Record<string, unknown>) ?? {};
      }
      return plain;
    }
  } catch {
    /* fallthrough */
  }
  const wrapped = tryParseNameArgsObject(trimmed);
  if (wrapped && wrapped.name === toolName) return wrapped.args;
  return { _raw: trimmed };
}

/**
 * 从模型输出中提取工具调用：
 * 1) <tool name="x">{json}</tool>（内层可为纯 args 或 name+args）
 * 2) ```json 代码块内含 {"name","args"}
 * 3) 独立成行且可被 JSON.parse 的 {"name","args"} 行
 */
export function extractToolCalls(text: string): { cleaned: string; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const seen = new Set<string>();

  const push = (c: ToolCall) => {
    if (!KNOWN_TOOLS.has(c.name)) return;
    const k = dedupeKey(c);
    if (seen.has(k)) return;
    seen.add(k);
    calls.push(c);
  };

  // 1) XML
  const reXml = /<tool\s+name="([^"]+)">\s*([\s\S]*?)<\/tool>/gi;
  let m: RegExpExecArray | null;
  while ((m = reXml.exec(text))) {
    const name = m[1];
    const inner = m[2];
    const args = parseInnerToolJson(name, inner);
    push({ name, args });
  }
  let cleaned = text.replace(reXml, '').trim();

  // 2) ```json ... ``` 块
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fm: RegExpExecArray | null;
  while ((fm = fenceRe.exec(text))) {
    const block = fm[1].trim();
    const fromBlock = tryParseNameArgsObject(block);
    if (fromBlock) push(fromBlock);
    for (const line of block.split('\n')) {
      const row = tryParseNameArgsObject(line);
      if (row) push(row);
    }
  }

  // 3) 独立行 JSON（常见误输出）
  for (const line of text.split('\n')) {
    const row = tryParseNameArgsObject(line);
    if (row) push(row);
  }

  return { cleaned, calls };
}
