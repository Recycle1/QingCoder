/** 与 orchestrator / toolExecutor 共用的工具调用形状（本文件无 Node 依赖，可供 Webview 打包） */
export type ToolCall = { name: string; args: Record<string, unknown> };

const KNOWN_TOOLS = new Set(['list_dir', 'read_file', 'write_file', 'apply_patch', 'search_text', 'mcp_tool']);

/** 用户可见正文分段：普通文本 vs 工具块（独立面板展示） */
export type DisplaySegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; body: string };

/** 裸 JSON 仅含 args（模型常把 {"path":"."} 打在正文里），用于解析与从正文剥离 */
export function tryParseArgsOnlyTool(s: string): ToolCall | null {
  const t = s.trim();
  if (!t.startsWith('{')) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if ('name' in o && 'args' in o) return null;
  if (typeof o.query === 'string') {
    return {
      name: 'search_text',
      args: { query: o.query, glob: typeof o.glob === 'string' ? o.glob : '**/*' },
    };
  }
  if (typeof o.path === 'string' && typeof o.content === 'string') {
    return { name: 'write_file', args: { path: o.path, content: o.content } };
  }
  if (typeof o.path === 'string') {
    return { name: 'list_dir', args: { path: o.path } };
  }
  return null;
}

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
  // 2) ```json ... ``` 块
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fm: RegExpExecArray | null;
  while ((fm = fenceRe.exec(text))) {
    const block = fm[1].trim();
    const fromBlock = tryParseNameArgsObject(block);
    if (fromBlock) push(fromBlock);
    else {
      const bare = tryParseArgsOnlyTool(block);
      if (bare) push(bare);
    }
    for (const line of block.split('\n')) {
      const row = tryParseNameArgsObject(line);
      if (row) push(row);
      else {
        const b = tryParseArgsOnlyTool(line);
        if (b) push(b);
      }
    }
  }

  // 3) 独立行 JSON（常见误输出）
  for (const line of text.split('\n')) {
    const row = tryParseNameArgsObject(line);
    if (row) push(row);
    else {
      const b = tryParseArgsOnlyTool(line);
      if (b) push(b);
    }
  }

  const cleaned = stripToolMarkersForDisplay(text);
  return { cleaned, calls };
}

function mergeAdjacentTextSegments(segments: DisplaySegment[]): DisplaySegment[] {
  const merged: DisplaySegment[] = [];
  for (const seg of segments) {
    if (seg.kind === 'text' && !seg.text) continue;
    const last = merged[merged.length - 1];
    if (seg.kind === 'text' && last?.kind === 'text') {
      last.text += seg.text;
    } else {
      merged.push(seg);
    }
  }
  return merged;
}

function formatToolBodyFromXml(toolName: string, inner: string): string {
  const args = parseInnerToolJson(toolName, inner);
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return inner.trim();
  }
}

type LineOrd = { t: 'tool'; call: ToolCall } | { t: 'ln'; s: string };

function splitInlinePathJsonTool(text: string): DisplaySegment[] {
  const parts: DisplaySegment[] = [];
  const inlineRe = /\{["']path["']\s*:\s*["'][^"']*["']\s*\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = inlineRe.exec(text))) {
    if (m.index > last) parts.push({ kind: 'text', text: text.slice(last, m.index) });
    const sub = m[0];
    const bare = tryParseArgsOnlyTool(sub);
    if (bare) {
      parts.push({ kind: 'tool', name: bare.name, body: JSON.stringify(bare.args, null, 2) });
    } else {
      parts.push({ kind: 'text', text: sub });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return mergeAdjacentTextSegments(parts);
}

/** 无 `<tool>` 的片段：处理 ```json``` 围栏与独立工具行、行内 path JSON */
function processTextGapWithoutXml(gap: string): DisplaySegment[] {
  if (!gap) return [];
  const out: DisplaySegment[] = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let last = 0;
  let fm: RegExpExecArray | null;
  while ((fm = fenceRe.exec(gap))) {
    if (fm.index > last) {
      out.push(...processLineOrderedText(gap.slice(last, fm.index)));
    }
    const inner = fm[1].trim();
    const named = tryParseNameArgsObject(inner);
    const bare = named ? null : tryParseArgsOnlyTool(inner);
    if (named || bare) {
      const c = named ?? bare!;
      out.push({ kind: 'tool', name: c.name, body: JSON.stringify(c.args, null, 2) });
    } else {
      out.push({ kind: 'text', text: fm[0] });
    }
    last = fm.index + fm[0].length;
  }
  if (last < gap.length) {
    out.push(...processLineOrderedText(gap.slice(last)));
  }
  return mergeAdjacentTextSegments(out);
}

function processLineOrderedText(s: string): DisplaySegment[] {
  if (!s) return [];
  const ordered: LineOrd[] = [];
  for (const line of s.split('\n')) {
    const tr = line.trim();
    const row = tr ? tryParseNameArgsObject(tr) ?? tryParseArgsOnlyTool(tr) : null;
    if (row) ordered.push({ t: 'tool', call: row });
    else ordered.push({ t: 'ln', s: line });
  }
  const out: DisplaySegment[] = [];
  let i = 0;
  while (i < ordered.length) {
    if (ordered[i].t === 'tool') {
      const c = (ordered[i] as { t: 'tool'; call: ToolCall }).call;
      out.push({ kind: 'tool', name: c.name, body: JSON.stringify(c.args, null, 2) });
      i++;
      continue;
    }
    const lines: string[] = [];
    while (i < ordered.length && ordered[i].t === 'ln') {
      lines.push((ordered[i] as { t: 'ln'; s: string }).s);
      i++;
    }
    out.push(...splitInlinePathJsonTool(lines.join('\n')));
  }
  return mergeAdjacentTextSegments(out);
}

/**
 * 将模型正文拆成「文本 / 工具」交替片段，顺序与原文一致，供 UI 分块展示。
 */
export function segmentToolMarkersForDisplay(text: string): DisplaySegment[] {
  const reXml = /<tool\s+name="([^"]+)">\s*([\s\S]*?)<\/tool>/gi;
  const out: DisplaySegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = reXml.exec(text))) {
    if (m.index > last) {
      out.push(...processTextGapWithoutXml(text.slice(last, m.index)));
    }
    out.push({ kind: 'tool', name: m[1], body: formatToolBodyFromXml(m[1], m[2]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push(...processTextGapWithoutXml(text.slice(last)));
  }
  return mergeAdjacentTextSegments(out);
}

/** 从对用户展示的文本中移除工具标签、工具 JSON 代码块与独立工具参数行（与分段逻辑一致） */
export function stripToolMarkersForDisplay(text: string): string {
  const joined = segmentToolMarkersForDisplay(text)
    .filter((s): s is { kind: 'text'; text: string } => s.kind === 'text')
    .map((s) => s.text)
    .join('');
  return joined.trim();
}
