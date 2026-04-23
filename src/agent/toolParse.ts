import type { ToolCall } from './toolExecutor';

/** 从模型输出中提取 <tool name="x">{json}</tool> */
export function extractToolCalls(text: string): { cleaned: string; calls: ToolCall[] } {
  const re = /<tool\s+name="([^"]+)">\s*([\s\S]*?)<\/tool>/g;
  const calls: ToolCall[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = m[1];
    const raw = m[2].trim();
    try {
      const args = JSON.parse(raw) as Record<string, unknown>;
      calls.push({ name, args });
    } catch {
      calls.push({ name, args: { _raw: raw } });
    }
  }
  const cleaned = text.replace(re, '').trim();
  return { cleaned, calls };
}
