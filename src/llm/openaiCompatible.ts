export type ChatMessageApi = {
  role: 'system' | 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }
      >;
};

/** 规范化为「目录」形式，便于拼接 chat/completions，并修正常见错误写法 */
export function normalizeChatApiBaseUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return 'https://api.openai.com/v1/';
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase();
    // 很多人只填 https://api.openai.com ，缺 /v1 会变成 .../chat/completions 打到错误路径
    if (host === 'api.openai.com') {
      const path = u.pathname.replace(/\/$/, '') || '/';
      if (path === '/' || path === '') {
        u.pathname = '/v1/';
      } else if (path === '/v1') {
        u.pathname = '/v1/';
      }
      let out = u.toString();
      if (!out.endsWith('/')) out += '/';
      return out;
    }
    return s.endsWith('/') ? s : `${s}/`;
  } catch {
    return s.endsWith('/') ? s : `${s}/`;
  }
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const base = normalizeChatApiBaseUrl(baseUrl);
  return `${base.replace(/\/+$/, '')}/chat/completions`;
}

/** o1 / o3 等推理模型不接受自定义 temperature */
function shouldOmitTemperature(model: string): boolean {
  const m = model.trim().toLowerCase();
  return /^o[0-9]/.test(m) || m.startsWith('o1') || m.startsWith('o3');
}

function parseSseDataLine(line: string): string | null {
  const s = line.trim();
  if (!s || s.startsWith(':')) return null;
  if (!s.startsWith('data:')) return null;
  const data = s.slice(5).trimStart();
  if (data === '[DONE]') return '__DONE__';
  try {
    const json = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string | null } }>;
    };
    const delta = json.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length) return delta;
  } catch {
    /* 半行 JSON 等下一 chunk */
  }
  return null;
}

export async function* streamChatCompletion(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessageApi[];
  signal?: AbortSignal;
}): AsyncGenerator<string> {
  const key = params.apiKey.trim();
  if (!key) throw new Error('API Key 为空，请检查 Token 是否已保存');

  const url = buildChatCompletionsUrl(params.baseUrl);
  const body: Record<string, unknown> = {
    model: params.model.trim(),
    messages: params.messages,
    stream: true,
  };
  if (!shouldOmitTemperature(params.model)) {
    body.temperature = 0.2;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}: ${t || res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    if (params.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    let readResult: { done: boolean; value?: Uint8Array };
    try {
      readResult = await reader.read();
    } catch (e) {
      if (params.signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
        throw new DOMException('Aborted', 'AbortError');
      }
      throw e;
    }
    const { value, done } = readResult;
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const piece = parseSseDataLine(line);
      if (piece === '__DONE__') return;
      if (piece) yield piece;
    }
  }
  buf += decoder.decode();
  if (buf.trim()) {
    for (const line of buf.split('\n')) {
      const piece = parseSseDataLine(line);
      if (piece === '__DONE__') return;
      if (piece) yield piece;
    }
  }
}
