import type {
  HostToWebview,
  WebviewToHost,
  UiState,
  AgentMode,
  ChatMessageDto,
  AgentActivityItem,
} from '../types/protocol';
import { renderAssistantMarkdown } from './renderMarkdown';

declare function acquireVsCodeApi(): { postMessage(msg: WebviewToHost): void };

const vscode = acquireVsCodeApi();

type LocalState = {
  ui: UiState | null;
  messagesBySession: Record<string, ChatMessageDto[]>;
  agentActivityBySession: Record<string, AgentActivityItem[]>;
  /** 输入框上方「执行与改动」折叠区是否展开 */
  agentFoldOpen: boolean;
  draft: string;
  streaming: { sessionId: string; id: string; buf: string } | null;
};

const st: LocalState = {
  ui: null,
  messagesBySession: {},
  agentActivityBySession: {},
  agentFoldOpen: false,
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
function formatAgentRow(item: AgentActivityItem): string {
  switch (item.kind) {
    case 'tools_detected':
      return item.detail ?? '检测到工具调用';
    case 'tool_running':
      return `运行 ${item.toolName ?? 'tool'}${item.detail ? ` · ${item.detail}` : ''}`;
    case 'tool_done':
      return `${item.ok === false ? '失败' : '完成'} ${item.toolName ?? 'tool'}${item.detail ? ` · ${item.detail}` : ''}`;
    case 'followup_model':
      return item.detail ?? '模型后续步骤';
    default:
      return item.detail ?? '';
  }
}

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
      el(
        'span',
        'qc-pending-text',
        `待确认 ${p.files.length} 个文件 · ` + p.files.map((f) => (f.path.split(/[/\\]/).pop() ?? f.path)).join(', ')
      )
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

  const sid = st.ui?.activeSessionId;
  const act = sid ? st.agentActivityBySession[sid] ?? [] : [];

  const chat = el('div', 'qc-chat');
  const msgs = sid ? st.messagesBySession[sid] ?? [] : [];
  for (const m of msgs) {
    const bubble = el('div', 'qc-msg qc-msg-' + m.role);
    const text = m.parts.map((x) => (x.type === 'text' ? x.text : '[image]')).join('\n');
    if (m.role === 'assistant') {
      const streamingThis = st.streaming?.sessionId === sid && st.streaming?.id === m.id;
      if (streamingThis) {
        bubble.classList.add('qc-msg-streaming');
        bubble.textContent = text;
      } else {
        bubble.classList.add('qc-msg-md');
        bubble.innerHTML = renderAssistantMarkdown(text);
      }
    } else {
      bubble.textContent = text;
    }
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

  const pendingStats = p?.hasBatch && p.files.length > 0 ? p.files : [];
  const showComposeFold = act.length > 0 || pendingStats.length > 0;
  if (showComposeFold) {
    const fold = el('div', 'qc-compose-fold' + (st.agentFoldOpen ? ' qc-compose-fold--open' : ''));
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'qc-compose-fold-head';
    head.onclick = () => {
      st.agentFoldOpen = !st.agentFoldOpen;
      render();
    };
    const chev = el('span', 'qc-compose-fold-chev', st.agentFoldOpen ? '▼' : '▶');
    head.appendChild(chev);
    const titleBits: string[] = [];
    if (act.length) titleBits.push(`执行 ${act.length} 步`);
    if (pendingStats.length) titleBits.push(`${pendingStats.length} 个文件待确认`);
    head.appendChild(el('span', 'qc-compose-fold-title', titleBits.join(' · ') || '详情'));
    if (pendingStats.length) {
      const sumA = pendingStats.reduce((s, f) => s + f.added, 0);
      const sumR = pendingStats.reduce((s, f) => s + f.removed, 0);
      const wrap = el('span', 'qc-compose-fold-stats');
      wrap.appendChild(el('span', 'qc-line-add', `+${sumA}`));
      wrap.appendChild(document.createTextNode(' '));
      wrap.appendChild(el('span', 'qc-line-del', `−${sumR}`));
      head.appendChild(wrap);
    }
    fold.appendChild(head);

    if (st.agentFoldOpen) {
      const body = el('div', 'qc-compose-fold-body');
      if (act.length) {
        body.appendChild(el('div', 'qc-compose-fold-subhead', '执行过程'));
        for (const item of act) {
          const row = el('div', 'qc-agent-row qc-agent-row-' + item.kind);
          row.textContent = formatAgentRow(item);
          body.appendChild(row);
        }
      }
      if (pendingStats.length) {
        body.appendChild(el('div', 'qc-compose-fold-subhead', '待确认文件'));
        for (const f of pendingStats) {
          const row = el('div', 'qc-pending-file-row');
          const short = f.path.split(/[/\\]/).pop() ?? f.path;
          row.appendChild(el('span', 'qc-pending-file-name', short));
          row.appendChild(el('span', 'qc-line-add', `+${f.added}`));
          row.appendChild(document.createTextNode(' '));
          row.appendChild(el('span', 'qc-line-del', `−${f.removed}`));
          body.appendChild(row);
        }
      }
      fold.appendChild(body);
    }
    main.appendChild(fold);
  }

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
  if (msg.type === 'agentActivityClear') {
    st.agentActivityBySession[msg.sessionId] = [];
    render();
  }
  if (msg.type === 'agentActivity') {
    const arr = (st.agentActivityBySession[msg.sessionId] ??= []);
    arr.push(msg.item);
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
.qc-compose-fold { flex-shrink:0; border-top:1px solid var(--vscode-widget-border); border-bottom:1px solid var(--vscode-widget-border); background: var(--vscode-sideBar-background); font-size:11px;}
.qc-compose-fold-head { width:100%; box-sizing:border-box; display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; padding:6px 10px; margin:0; border:none; cursor:pointer; text-align:left; color: inherit; background: transparent; font: inherit;}
.qc-compose-fold-head:hover { background: var(--vscode-list-hoverBackground);}
.qc-compose-fold-chev { flex-shrink:0; width:1em; opacity:0.85;}
.qc-compose-fold-title { flex:1; min-width:100px; opacity:0.95;}
.qc-compose-fold-stats { flex-shrink:0; font-family: var(--vscode-editor-font-family); font-variant-numeric: tabular-nums;}
.qc-compose-fold-body { max-height:160px; overflow:auto; padding:6px 10px 8px; display:flex; flex-direction:column; gap:4px; border-top:1px solid var(--vscode-widget-border); background: var(--vscode-editor-background);}
.qc-compose-fold-subhead { font-weight:600; font-size:10px; opacity:0.85; margin-top:4px;}
.qc-compose-fold-subhead:first-child { margin-top:0;}
.qc-agent-row { font-family: var(--vscode-editor-font-family); line-height:1.35; opacity:0.92; border-left:2px solid var(--vscode-input-border); padding-left:6px;}
.qc-agent-row-tool_running { border-left-color: var(--vscode-progressBar-background);}
.qc-agent-row-tool_done { border-left-color: var(--vscode-testing-iconPassed);}
.qc-agent-row-followup_model { border-left-color: var(--vscode-textLink-foreground);}
.qc-pending-file-row { display:flex; flex-wrap:wrap; align-items:center; gap:6px; font-family: var(--vscode-editor-font-family); line-height:1.4;}
.qc-pending-file-name { flex:1; min-width:80px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.qc-line-add { color: var(--vscode-gitDecoration-addedResourceForeground); font-weight:500;}
.qc-line-del { color: var(--vscode-gitDecoration-deletedResourceForeground); font-weight:500;}
.qc-chat { flex:1; min-height:0; overflow:auto; overflow-anchor:none; padding:10px; display:flex; flex-direction:column; gap:10px;}
.qc-msg { padding:10px 12px; border-radius:8px; max-width:92%; line-height:1.45;}
.qc-msg-streaming { white-space:pre-wrap;}
.qc-msg-md { white-space:normal; word-break:break-word;}
.qc-msg-md .qc-md-empty { opacity:0.7; font-style:italic;}
.qc-msg-md p { margin:0.4em 0;}
.qc-msg-md p:first-child { margin-top:0;}
.qc-msg-md p:last-child { margin-bottom:0;}
.qc-msg-md pre { margin:0.5em 0; padding:8px; overflow:auto; max-width:100%; background: var(--vscode-textCodeBlock-background); border-radius:4px; font-family: var(--vscode-editor-font-family); font-size:11px;}
.qc-msg-md code { font-family: var(--vscode-editor-font-family); font-size:0.92em; background: var(--vscode-textPreformat-background); padding:0.1em 0.35em; border-radius:3px;}
.qc-msg-md pre code { padding:0; background:transparent;}
.qc-msg-md ul, .qc-msg-md ol { margin:0.35em 0 0.35em 1.2em; padding:0;}
.qc-msg-md blockquote { margin:0.4em 0; padding-left:8px; border-left:3px solid var(--vscode-widget-border); opacity:0.95;}
.qc-msg-md a { color: var(--vscode-textLink-foreground);}
.qc-msg-md h1, .qc-msg-md h2, .qc-msg-md h3 { font-size:1.05em; margin:0.5em 0 0.25em; font-weight:600;}
.qc-msg-md table { border-collapse:collapse; font-size:11px; margin:0.5em 0;}
.qc-msg-md th, .qc-msg-md td { border:1px solid var(--vscode-widget-border); padding:4px 6px;}
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
