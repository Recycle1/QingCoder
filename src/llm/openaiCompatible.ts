export type ChatMessageApi = {
  role: 'system' | 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }
      >;
};

export async function* streamChatCompletion(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessageApi[];
  signal?: AbortSignal;
}): AsyncGenerator<string> {
  const url = new URL('chat/completions', joinBase(params.baseUrl));
  const body = {
    model: params.model,
    messages: params.messages,
    stream: true,
    temperature: 0.2,
  };
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.apiKey}`,
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
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const data = s.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        /* ignore partial json */
      }
    }
  }
}

function joinBase(baseUrl: string): string {
  const u = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return u;
}
