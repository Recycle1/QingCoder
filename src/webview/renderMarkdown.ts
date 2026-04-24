import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({
  gfm: true,
  breaks: true,
});

/** 将助手 Markdown 转为可安全插入 Webview 的 HTML */
export function renderAssistantMarkdown(source: string): string {
  const s = source.trim();
  if (!s) return '<p class="qc-md-empty">（空）</p>';
  const html = marked.parse(s, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|vscode-file):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  });
}
