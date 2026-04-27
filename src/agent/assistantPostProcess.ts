import type { ChatContentPart, QuickReply } from '../core/sessionStore';
import { segmentToolMarkersForDisplay } from './toolParse';

const CHOICE_BLOCK = /<<<QINGCHOICES\n([\s\S]*?)\n>>>/;

/**
 * 从模型原始输出得到落库结构：工具块拆成 tool_trace 与正文分开展示、拆分 thinking、解析快捷选项。
 */
export function formatAssistantMessageParts(raw: string): { parts: ChatContentPart[]; quickReplies: QuickReply[] } {
  let t = raw.trim();
  const OUT = '<<OUTPUT>>';
  const oi = t.indexOf(OUT);
  const thinkingChunks: string[] = [];
  if (oi !== -1) {
    const pre = t.slice(0, oi).trimEnd();
    if (pre) thinkingChunks.push(pre);
    t = t.slice(oi + OUT.length).replace(/^[\r\n]+/, '').trim();
  }

  const quickReplies: QuickReply[] = [];
  const cm = t.match(CHOICE_BLOCK);
  if (cm) {
    const body = cm[1];
    for (const line of body.split('\n')) {
      const idx = line.indexOf('\t');
      if (idx <= 0) continue;
      const label = line.slice(0, idx).trim();
      const payload = line.slice(idx + 1).trim();
      if (label && payload) quickReplies.push({ label, payload });
    }
    t = t.replace(CHOICE_BLOCK, '').trim();
  }

  t = t.replace(/<thinking>([\s\S]*?)<\/thinking>/gi, (_, inner: string) => {
    thinkingChunks.push(inner.trim());
    return '';
  });
  t = t.replace(/\n{3,}/g, '\n\n').trim();

  const parts: ChatContentPart[] = [];
  if (thinkingChunks.length) {
    parts.push({ type: 'thinking', text: thinkingChunks.join('\n\n') });
  }

  const segments = segmentToolMarkersForDisplay(t);
  let anyBody = false;
  for (const seg of segments) {
    if (seg.kind === 'text') {
      const tx = seg.text.replace(/\n{3,}/g, '\n\n').trim();
      if (tx) {
        parts.push({ type: 'text', text: tx });
        anyBody = true;
      }
    } else {
      parts.push({ type: 'tool_trace', name: seg.name, body: seg.body });
      anyBody = true;
    }
  }
  if (!anyBody) {
    parts.push({ type: 'text', text: '（无正文）' });
  }
  return { parts, quickReplies };
}
