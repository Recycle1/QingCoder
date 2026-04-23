import type { HostToWebview, WebviewToHost, UiState, AgentMode, ChatMessageDto } from '../types/protocol';

declare function acquireVsCodeApi(): { postMessage(msg: WebviewToHost): void };

const vscode = acquireVsCodeApi();

type LocalState = {
  ui: UiState | null;
  messagesBySession: Record<string, ChatMessageDto[]>;
  draft: string;
  streaming: { sessionId: string; id: string; buf: string } | null;
};

const st: LocalState = {
  ui: null,
  messagesBySession: {},
  draft: '',
  streaming: null,
};

const app = document.getElementById('app');
if (!app) throw new Error('#app missing');

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function render() {
  app.innerHTML = '';
  const root = el('div', 'qc-root');

  const top = el('div', 'qc-top');
  const pendingBar = el('div', 'qc-pending');
  const p = st.ui?.pending;
  if (p?.hasBatch) {
    pendingBar.appendChild(el('span', 'qc-muted', `待确认文件 (${p.files.length})：`));
    pendingBar.appendChild(el('span', 'qc-mono', p.files.map((f) => f.split(/[/\\]/).pop()).join(', ')));
    const btnRow = el('div', 'qc-btn-row');
    btnRow.appendChild(btn('Keep All', () => vscode.postMessage({ type: 'keepAll' })));
    btnRow.appendChild(btn('Undo All', () => vscode.postMessage({ type: 'undoAll' })));
    btnRow.appendChild(btn('Review', () => vscode.postMessage({ type: 'review' })));
    pendingBar.appendChild(btnRow);
  } else {
    pendingBar.appendChild(el('span', 'qc-muted', '无待确认批次（Agent 写入后可撤销）'));
  }
  top.appendChild(pendingBar);

  const modeRow = el('div', 'qc-row');
  modeRow.appendChild(el('span', 'qc-label', '模式'));
  for (const m of ['ask', 'plan', 'agent'] as const) {
    modeRow.appendChild(
      chip(m, st.ui?.mode === m, () => vscode.postMessage({ type: 'setMode', mode: m as AgentMode }))
    );
  }
  top.appendChild(modeRow);

  const mcpRow = el('div', 'qc-row');
  const mcp = st.ui?.mcp;
  mcpRow.appendChild(
    el(
      'span',
      'qc-muted',
      mcp?.loadedPath
        ? `MCP: ${mcp.loadedPath}（${mcp.serverCount} 服务）`
        : 'MCP: 未找到工作区 mcp.json / .vscode/mcp.json'
    )
  );
  mcpRow.appendChild(btn('重载 MCP', () => vscode.postMessage({ type: 'reloadMcp' })));
  if (mcp?.lastError) mcpRow.appendChild(el('span', 'qc-error', mcp.lastError));
  top.appendChild(mcpRow);

  root.appendChild(top);

  const body = el('div', 'qc-body');
  const sidebar = el('div', 'qc-sidebar');
  sidebar.appendChild(el('div', 'qc-side-title', '会话'));
  sidebar.appendChild(btn('+ 新建', () => vscode.postMessage({ type: 'newSession' })));
  const list = el('div', 'qc-session-list');
  for (const s of st.ui?.sessions ?? []) {
    const item = el('div', 'qc-session' + (st.ui?.activeSessionId === s.id ? ' qc-session-active' : ''));
    const title = el('span', 'qc-session-title', `${s.title} · ${s.messageCount}`);
    item.appendChild(title);
    item.onclick = () => vscode.postMessage({ type: 'switchSession', sessionId: s.id });
    const del = el('button', 'qc-del', '×');
    del.onclick = (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'deleteSession', sessionId: s.id });
    };
    item.appendChild(del);
    list.appendChild(item);
  }
  sidebar.appendChild(list);
  body.appendChild(sidebar);

  const main = el('div', 'qc-main');
  const chat = el('div', 'qc-chat');
  const sid = st.ui?.activeSessionId;
  const msgs = sid ? st.messagesBySession[sid] ?? [] : [];
  for (const m of msgs) {
    const bubble = el('div', 'qc-msg qc-msg-' + m.role);
    const text = m.parts
      .map((p) => (p.type === 'text' ? p.text : '[image]'))
      .join('\n');
    bubble.textContent = text;
    chat.appendChild(bubble);
  }
  chat.scrollTop = chat.scrollHeight;
  main.appendChild(chat);

  const controls = el('div', 'qc-controls');
  const modelRow = el('div', 'qc-row');
  modelRow.appendChild(el('span', 'qc-label', '模型档案'));
  const sel = document.createElement('select');
  for (const p of st.ui?.modelProfiles ?? []) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = `${p.label} · ${p.defaultModel}`;
    if (p.id === st.ui?.activeProfileId) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => vscode.postMessage({ type: 'setModelProfile', profileId: sel.value });
  modelRow.appendChild(sel);
  modelRow.appendChild(btn('保存 Token', () => openTokenModal()));
  controls.appendChild(modelRow);

  const ta = document.createElement('textarea');
  ta.className = 'qc-input';
  ta.placeholder = '输入需求，支持多轮上下文；可粘贴截图到输入区（后续可扩展图片按钮）';
  ta.value = st.draft;
  ta.oninput = () => (st.draft = ta.value);
  controls.appendChild(ta);

  const sendRow = el('div', 'qc-row');
  sendRow.appendChild(
    btn('发送', () => {
      const text = ta.value.trim();
      if (!text || !sid) return;
      ta.value = '';
      st.draft = '';
      vscode.postMessage({ type: 'sendMessage', sessionId: sid, text });
    })
  );
  sendRow.appendChild(el('span', 'qc-muted', '图片：请使用支持视觉的模型，并在后续版本添加选择器'));
  controls.appendChild(sendRow);

  main.appendChild(controls);
  body.appendChild(main);
  root.appendChild(body);

  const style = el('style');
  style.textContent = css;
  root.appendChild(style);

  app.appendChild(root);
}

function btn(label: string, onClick: () => void) {
  const b = document.createElement('button');
  b.className = 'qc-btn';
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

function chip(label: string, on: boolean, onClick: () => void) {
  const b = document.createElement('button');
  b.className = 'qc-chip' + (on ? ' qc-chip-on' : '');
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

function openTokenModal() {
  const id = st.ui?.activeProfileId;
  if (!id) return;
  const token = prompt('粘贴 API Token（仅保存在本机 VS Code SecretStorage）');
  if (!token) return;
  vscode.postMessage({ type: 'saveToken', profileId: id, token });
}

window.addEventListener('message', (ev: MessageEvent<HostToWebview>) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'state') {
    st.ui = msg.payload;
    render();
  }
  if (msg.type === 'sessionMessages') {
    st.messagesBySession[msg.sessionId] = msg.messages;
    render();
  }
  if (msg.type === 'stream') {
    if (!st.streaming || st.streaming.id !== msg.id) {
      st.streaming = { sessionId: msg.sessionId, id: msg.id, buf: '' };
    }
    st.streaming.buf += msg.delta;
    const list = (st.messagesBySession[msg.sessionId] ??= []);
    let idx = list.findIndex((m) => m.id === msg.id);
    if (idx < 0) {
      list.push({
        id: msg.id,
        role: 'assistant',
        createdAt: Date.now(),
        parts: [{ type: 'text', text: '' }],
      });
      idx = list.length - 1;
    }
    list[idx].parts = [{ type: 'text', text: st.streaming.buf }];
    render();
  }
  if (msg.type === 'streamEnd') {
    st.streaming = null;
    render();
  }
  if (msg.type === 'error') {
    alert(msg.message);
  }
  if (msg.type === 'toast') {
    /* eslint-disable no-console */
    console.info(msg.message);
  }
});

vscode.postMessage({ type: 'ready' });

const css = `
.qc-root { display:flex; flex-direction:column; height:100vh; color: var(--vscode-foreground); font-size:12px; }
.qc-top { border-bottom:1px solid var(--vscode-widget-border); padding:8px; display:flex; flex-direction:column; gap:6px; }
.qc-body { flex:1; display:flex; min-height:0; }
.qc-sidebar { width:160px; border-right:1px solid var(--vscode-widget-border); padding:8px; overflow:auto; display:flex; flex-direction:column; gap:6px;}
.qc-session { padding:4px 6px; border-radius:4px; cursor:pointer; position:relative; padding-right:18px; display:flex; align-items:center; gap:4px;}
.qc-session-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.qc-session-active { background: var(--vscode-list-inactiveSelectionBackground); }
.qc-del { position:absolute; right:2px; top:2px; border:none; background:transparent; cursor:pointer;}
.qc-main { flex:1; display:flex; flex-direction:column; min-width:0;}
.qc-chat { flex:1; overflow:auto; padding:8px; display:flex; flex-direction:column; gap:8px;}
.qc-msg { padding:8px; border-radius:6px; max-width:95%; white-space:pre-wrap;}
.qc-msg-user { align-self:flex-end; background: var(--vscode-input-background); }
.qc-msg-assistant { align-self:flex-start; background: var(--vscode-editor-inactiveSelectionBackground); }
.qc-controls { border-top:1px solid var(--vscode-widget-border); padding:8px; display:flex; flex-direction:column; gap:6px;}
.qc-input { width:100%; min-height:72px; resize:vertical; color:inherit; background: var(--vscode-input-background); border:1px solid var(--vscode-input-border); border-radius:4px; padding:6px;}
.qc-row { display:flex; flex-wrap:wrap; gap:6px; align-items:center;}
.qc-btn { padding:4px 8px; cursor:pointer; border-radius:4px; border:1px solid var(--vscode-button-border); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);}
.qc-chip { padding:2px 8px; border-radius:999px; border:1px solid var(--vscode-widget-border); background:transparent; cursor:pointer;}
.qc-chip-on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent;}
.qc-label { font-weight:600;}
.qc-muted { opacity:0.75;}
.qc-error { color: var(--vscode-errorForeground);}
.qc-mono { font-family: var(--vscode-editor-font-family); font-size:11px;}
.qc-pending { display:flex; flex-direction:column; gap:4px;}
.qc-btn-row { display:flex; gap:6px; flex-wrap:wrap;}
`;

render();
