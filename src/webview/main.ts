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

function btn(label: string, onClick: () => void, title?: string) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'qc-btn';
  b.textContent = label;
  if (title) b.title = title;
  b.onclick = onClick;
  return b;
}

/** 聊天区滚到最新（双帧等待布局后再滚，避免卡在顶部） */
function scrollChatToBottom() {
  requestAnimationFrame(() => {
    const el = document.querySelector('.qc-chat');
    if (el) el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      const el2 = document.querySelector('.qc-chat');
      if (el2) el2.scrollTop = el2.scrollHeight;
    });
  });
}

function render() {
  app.innerHTML = '';
  const root = el('div', 'qc-root');
  const sidebarOpen = st.ui?.sidebarOpen === true;

  const toggle = btn(sidebarOpen ? '⟨' : '⟩', () => {
    vscode.postMessage({ type: 'setSidebarOpen', open: !sidebarOpen });
  }, sidebarOpen ? '收起会话侧栏' : '展开会话侧栏');
  toggle.className = 'qc-btn qc-sb-toggle';
  root.appendChild(toggle);

  const sessionPanel = el('aside', 'qc-session-panel' + (sidebarOpen ? '' : ' qc-session-panel--collapsed'));
  sessionPanel.appendChild(el('div', 'qc-side-head', '会话'));
  sessionPanel.appendChild(
    btn('+ 新建', () => vscode.postMessage({ type: 'newSession' }), '新建会话')
  );
  const list = el('div', 'qc-session-list');
  for (const s of st.ui?.sessions ?? []) {
    const item = el('div', 'qc-session' + (st.ui?.activeSessionId === s.id ? ' qc-session-active' : ''));
    const title = el('span', 'qc-session-title', `${s.title} · ${s.messageCount}`);
    item.appendChild(title);
    item.onclick = () => vscode.postMessage({ type: 'switchSession', sessionId: s.id });
    const del = el('button', 'qc-del', '×');
    del.onclick = (e) => {
      e.stopPropagation();
      if (!confirm('删除此会话？')) return;
      vscode.postMessage({ type: 'deleteSession', sessionId: s.id });
    };
    item.appendChild(del);
    list.appendChild(item);
  }
  sessionPanel.appendChild(list);
  root.appendChild(sessionPanel);

  const main = el('div', 'qc-maincol');

  const pendingStrip = el('div', 'qc-pending-strip');
  const p = st.ui?.pending;
  if (p?.hasBatch) {
    pendingStrip.appendChild(
      el('span', 'qc-pending-text', `待确认 ${p.files.length} 个文件 · ` + p.files.map((f) => f.split(/[/\\]/).pop()).join(', '))
    );
    const actions = el('span', 'qc-pending-actions');
    actions.appendChild(btn('Keep All', () => vscode.postMessage({ type: 'keepAll' })));
    actions.appendChild(btn('Undo All', () => vscode.postMessage({ type: 'undoAll' })));
    actions.appendChild(btn('Review', () => vscode.postMessage({ type: 'review' })));
    pendingStrip.appendChild(actions);
  } else {
    pendingStrip.classList.add('qc-pending-strip--idle');
    pendingStrip.appendChild(el('span', 'qc-muted', '无待确认改动'));
  }
  main.appendChild(pendingStrip);

  const chat = el('div', 'qc-chat');
  const sid = st.ui?.activeSessionId;
  const msgs = sid ? st.messagesBySession[sid] ?? [] : [];
  for (const m of msgs) {
    const bubble = el('div', 'qc-msg qc-msg-' + m.role);
    bubble.textContent = m.parts.map((x) => (x.type === 'text' ? x.text : '[image]')).join('\n');
    chat.appendChild(bubble);
  }
  main.appendChild(chat);

  const toolbar = el('div', 'qc-toolbar');
  toolbar.appendChild(el('span', 'qc-tlabel', '模式'));
  const modeSel = document.createElement('select');
  modeSel.className = 'qc-select qc-select--sm';
  for (const m of ['ask', 'plan', 'agent'] as const) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = m === 'ask' ? 'Ask' : m === 'plan' ? 'Plan' : 'Agent';
    if (st.ui?.mode === m) o.selected = true;
    modeSel.appendChild(o);
  }
  modeSel.onchange = () => vscode.postMessage({ type: 'setMode', mode: modeSel.value as AgentMode });
  toolbar.appendChild(modeSel);

  toolbar.appendChild(el('span', 'qc-tsep'));
  toolbar.appendChild(el('span', 'qc-tlabel', '服务'));
  const svcSel = document.createElement('select');
  svcSel.className = 'qc-select';
  const tc = st.ui?.tokenConfigured ?? {};
  for (const pr of st.ui?.modelProfiles ?? []) {
    const o = document.createElement('option');
    o.value = pr.id;
    o.textContent = `${pr.label}${tc[pr.id] ? ' ✓' : ''}`;
    if (pr.id === st.ui?.activeProfileId) o.selected = true;
    svcSel.appendChild(o);
  }
  svcSel.onchange = () => vscode.postMessage({ type: 'setModelProfile', profileId: svcSel.value });
  toolbar.appendChild(svcSel);

  toolbar.appendChild(el('span', 'qc-tsep'));
  toolbar.appendChild(el('span', 'qc-tlabel', '模型'));
  const modelIdSel = document.createElement('select');
  modelIdSel.className = 'qc-select qc-select--model';
  for (const mid of st.ui?.availableModels ?? []) {
    const o = document.createElement('option');
    o.value = mid;
    o.textContent = mid;
    if (mid === st.ui?.selectedModel) o.selected = true;
    modelIdSel.appendChild(o);
  }
  modelIdSel.onchange = () => vscode.postMessage({ type: 'setModelId', modelId: modelIdSel.value });
  toolbar.appendChild(modelIdSel);

  toolbar.appendChild(el('span', 'qc-tsep'));
  const mcp = st.ui?.mcp;
  const mcpTitle = mcp?.loadedPath
    ? `${mcp.loadedPath}\n${mcp.serverCount} 个 MCP 服务${mcp.lastError ? '\n错误: ' + mcp.lastError : ''}`
    : '未找到 mcp.json，点击扫描';
  toolbar.appendChild(btn('MCP ↻', () => vscode.postMessage({ type: 'reloadMcp' }), mcpTitle));

  toolbar.appendChild(
    btn('密钥…', () => vscode.postMessage({ type: 'openTokenWizard' }), '在顶部 QuickPick 中配置 Token')
  );

  const profs = st.ui?.modelProfiles ?? [];
  const nOk = profs.filter((x) => tc[x.id]).length;
  toolbar.appendChild(el('span', 'qc-token-badge', `Token ${nOk}/${profs.length}`));

  main.appendChild(toolbar);

  const ta = document.createElement('textarea');
  ta.className = 'qc-input';
  ta.placeholder = '输入消息…';
  ta.value = st.draft;
  ta.oninput = () => (st.draft = ta.value);
  main.appendChild(ta);

  const bottom = el('div', 'qc-bottom');
  const sendBtn = btn('发送', () => {
    const text = ta.value.trim();
    if (!text || !sid) return;
    ta.value = '';
    st.draft = '';
    vscode.postMessage({ type: 'sendMessage', sessionId: sid, text });
  });
  bottom.appendChild(sendBtn);

  const streaming = !!st.ui?.isStreaming;
  const stopBtn = btn('停止', () => vscode.postMessage({ type: 'stopGeneration' }), '中止当前生成');
  stopBtn.classList.add('qc-btn-stop');
  stopBtn.disabled = !streaming;
  bottom.appendChild(stopBtn);

  bottom.appendChild(
    el('span', 'qc-hint qc-muted', streaming ? '生成中…' : '停止会中断当前请求；命令面板：「QingCoder: 停止生成」')
  );
  main.appendChild(bottom);

  root.appendChild(main);

  const style = el('style');
  style.textContent = css;
  root.appendChild(style);

  app.appendChild(root);
  scrollChatToBottom();
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
    scrollChatToBottom();
  }
  if (msg.type === 'streamEnd') {
    st.streaming = null;
    render();
    scrollChatToBottom();
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
.qc-root { display:flex; flex-direction:row; height:100vh; color: var(--vscode-foreground); font-size:12px; min-height:0;}
.qc-sb-toggle { flex-shrink:0; width:28px; align-self:stretch; border:none; border-right:1px solid var(--vscode-widget-border); border-radius:0; background: var(--vscode-sideBar-background); cursor:pointer; font-size:14px;}
.qc-session-panel { flex-shrink:0; width:200px; display:flex; flex-direction:column; gap:6px; padding:8px; border-right:1px solid var(--vscode-widget-border); background: var(--vscode-sideBar-background); min-height:0;}
.qc-session-panel--collapsed { width:0; padding:0; overflow:hidden; border:none;}
.qc-side-head { font-weight:600; font-size:11px; opacity:0.9;}
.qc-session-list { flex:1; overflow:auto; display:flex; flex-direction:column; gap:4px; min-height:0;}
.qc-session { padding:6px 20px 6px 6px; border-radius:6px; cursor:pointer; position:relative; display:flex; align-items:center;}
.qc-session-active { background: var(--vscode-list-inactiveSelectionBackground); }
.qc-session-title { font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.qc-del { position:absolute; right:2px; top:4px; border:none; background:transparent; cursor:pointer; opacity:0.7;}
.qc-maincol { flex:1; min-width:0; display:flex; flex-direction:column; min-height:0;}
.qc-pending-strip { flex-shrink:0; display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:6px 8px; border-bottom:1px solid var(--vscode-widget-border); font-size:11px;}
.qc-pending-strip--idle { opacity:0.85;}
.qc-pending-text { flex:1; min-width:120px; }
.qc-pending-actions { display:flex; flex-wrap:wrap; gap:4px;}
.qc-chat { flex:1; min-height:0; overflow:auto; overflow-anchor:none; padding:10px; display:flex; flex-direction:column; gap:10px;}
.qc-msg { padding:10px 12px; border-radius:8px; max-width:92%; white-space:pre-wrap; line-height:1.45;}
.qc-msg-user { align-self:flex-end; background: var(--vscode-input-background); border:1px solid var(--vscode-input-border);}
.qc-msg-assistant { align-self:flex-start; background: var(--vscode-editor-inactiveSelectionBackground);}
.qc-toolbar { flex-shrink:0; display:flex; flex-wrap:wrap; align-items:center; gap:6px 8px; padding:8px; border-top:1px solid var(--vscode-widget-border); border-bottom:1px solid var(--vscode-widget-border); background: var(--vscode-sideBar-background);}
.qc-tlabel { font-size:11px; opacity:0.85; margin-right:-4px;}
.qc-tsep { width:1px; height:16px; background: var(--vscode-widget-border); margin:0 2px;}
.qc-select { max-width:160px; color:inherit; background: var(--vscode-dropdown-background); border:1px solid var(--vscode-dropdown-border); border-radius:4px; padding:3px 6px;}
.qc-select--sm { max-width:86px;}
.qc-select--model { max-width:220px;}
.qc-btn { padding:3px 8px; cursor:pointer; border-radius:4px; border:1px solid var(--vscode-button-border); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); font-size:11px;}
.qc-btn-stop { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground);}
.qc-btn:disabled { opacity:0.45; cursor:not-allowed;}
.qc-input { flex-shrink:0; width:100%; min-height:88px; box-sizing:border-box; resize:vertical; margin:0; padding:8px; color:inherit; background: var(--vscode-input-background); border:none; border-bottom:1px solid var(--vscode-widget-border);}
.qc-bottom { flex-shrink:0; display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:8px;}
.qc-hint { font-size:10px; flex:1; min-width:120px;}
.qc-muted { opacity:0.75;}
.qc-token-badge { font-size:11px; font-family: var(--vscode-editor-font-family); opacity:0.9;}
`;

render();
