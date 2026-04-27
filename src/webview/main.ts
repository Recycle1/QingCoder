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

/**
 * 主聊天区是否与底部对齐（≤2px 才算贴底）。
 * 仅由此状态决定「生成/重绘后是否滚到底」；用户一旦离开底部则不再跟随，直到再次贴底或发送消息。
 */
let chatAtBottom = true;
/** 程序化改 scrollTop 时忽略 scroll 事件，避免误判贴底状态 */
let suppressChatScrollStick = false;
/** 流式 thinking 小窗是否与底部对齐 */
let thinkingAtBottom = true;
let suppressThinkingScrollStick = false;

/** 用于切换会话时恢复「跟随底部」 */
let lastRenderedSessionId: string | undefined;

const appEl = document.getElementById('app');
if (!appEl) throw new Error('#app missing');
const app: HTMLElement = appEl;

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

const CHAT_BOTTOM_SLACK_PX = 2;

function isChatAtBottom(el: HTMLElement): boolean {
  const slack = el.scrollHeight - el.scrollTop - el.clientHeight;
  return slack <= CHAT_BOTTOM_SLACK_PX;
}

/** 仅应在「用户已贴底」时调用：把聊天滚到最新；不读全局流式状态 */
function scrollChatToBottomIfPinned() {
  if (!chatAtBottom) return;
  suppressChatScrollStick = true;
  requestAnimationFrame(() => {
    const el = document.querySelector('.qc-chat');
    if (el) el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      const el2 = document.querySelector('.qc-chat');
      if (el2) el2.scrollTop = el2.scrollHeight;
      suppressChatScrollStick = false;
    });
  });
}

function bindChatScrollStick(chatEl: HTMLElement) {
  chatEl.addEventListener(
    'scroll',
    () => {
      if (suppressChatScrollStick) return;
      chatAtBottom = isChatAtBottom(chatEl);
    },
    { passive: true }
  );
}

const THINKING_BOTTOM_SLACK_PX = 2;

function isThinkingAtBottom(bar: HTMLElement): boolean {
  return bar.scrollHeight - bar.scrollTop - bar.clientHeight <= THINKING_BOTTOM_SLACK_PX;
}

function scrollThinkingBarToBottomIfPinned(bar: HTMLElement) {
  if (!thinkingAtBottom) return;
  suppressThinkingScrollStick = true;
  requestAnimationFrame(() => {
    bar.scrollTop = bar.scrollHeight;
    requestAnimationFrame(() => {
      bar.scrollTop = bar.scrollHeight;
      suppressThinkingScrollStick = false;
    });
  });
}

function bindThinkingStreamScrollStick(bar: HTMLElement) {
  bar.addEventListener(
    'scroll',
    () => {
      if (suppressThinkingScrollStick) return;
      thinkingAtBottom = isThinkingAtBottom(bar);
    },
    { passive: true }
  );
}

function render() {
  /** 整页重绘会换掉 .qc-chat，必须在清空前记下距底部的距离，否则上滚读历史时会被锁在 scrollTop=0 */
  let chatScrollRestoreDist: number | null = null;
  const prevChat = app.querySelector('.qc-chat');
  if (prevChat instanceof HTMLElement && !chatAtBottom) {
    chatScrollRestoreDist = prevChat.scrollHeight - prevChat.scrollTop - prevChat.clientHeight;
  }

  app.innerHTML = '';
  const root = el('div', 'qc-root');
  const sidebarOpen = st.ui?.sidebarOpen === true;
  const sidPre = st.ui?.activeSessionId;
  if (sidPre !== lastRenderedSessionId) {
    chatAtBottom = true;
    thinkingAtBottom = true;
    lastRenderedSessionId = sidPre ?? undefined;
  }

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

  const sid = st.ui?.activeSessionId;
  const p = st.ui?.pending;
  const act = sid ? st.agentActivityBySession[sid] ?? [] : [];

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

  const pendingBar = el('div', 'qc-pending-above-chat');
  if (p?.hasBatch && p.files.length > 0) {
    pendingBar.appendChild(el('div', 'qc-pending-bar-title', '待确认改动'));
    const sel = document.createElement('select');
    sel.className = 'qc-select qc-pending-dropdown';
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = '选择文件查看 diff…';
    sel.appendChild(opt0);
    for (const f of p.files) {
      const o = document.createElement('option');
      o.value = f.path;
      const short = f.path.split(/[/\\]/).pop() ?? f.path;
      const hc = f.hunkCount ?? 0;
      const sd = f.stackDepth ?? 0;
      o.textContent = `${short}  +${f.added} −${f.removed}  · ${hc} 块 · ${sd} 步`;
      sel.appendChild(o);
    }
    sel.onchange = () => {
      const v = sel.value;
      if (v) vscode.postMessage({ type: 'openPendingDiff', path: v });
      sel.value = '';
    };
    pendingBar.appendChild(sel);
    const glob = el('div', 'qc-pending-global-actions');
    glob.appendChild(btn('Keep All', () => vscode.postMessage({ type: 'keepAll' })));
    glob.appendChild(btn('Undo All', () => vscode.postMessage({ type: 'undoAll' })));
    glob.appendChild(btn('Review 全部', () => vscode.postMessage({ type: 'review' })));
    pendingBar.appendChild(glob);
    for (const f of p.files) {
      const row = el('div', 'qc-pending-file-actions');
      const short = f.path.split(/[/\\]/).pop() ?? f.path;
      row.appendChild(el('span', 'qc-pending-file-name', short));
      row.appendChild(el('span', 'qc-line-add', `+${f.added}`));
      row.appendChild(document.createTextNode(' '));
      row.appendChild(el('span', 'qc-line-del', `−${f.removed}`));
      row.appendChild(el('span', 'qc-pending-meta', `${f.hunkCount ?? 0} 块`));
      const fp = f.path;
      row.appendChild(btn('Diff', () => vscode.postMessage({ type: 'openPendingDiff', path: fp }), f.path));
      if ((f.stackDepth ?? 0) > 0) {
        row.appendChild(btn('撤上一步', () => vscode.postMessage({ type: 'undoLastPatch', path: fp }), '撤销该文件最后一次写入'));
      }
      row.appendChild(btn('Keep', () => vscode.postMessage({ type: 'keepFile', path: fp })));
      row.appendChild(btn('Undo', () => vscode.postMessage({ type: 'undoFile', path: fp })));
      pendingBar.appendChild(row);
    }
  } else {
    pendingBar.classList.add('qc-pending-above-chat--idle');
    pendingBar.appendChild(el('span', 'qc-muted', '无待确认文件改动'));
  }

  let composeFoldEl: HTMLElement | null = null;
  const showComposeFold = act.length > 0;
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
    head.appendChild(el('span', 'qc-compose-fold-title', `工具与写入预览 · ${act.length} 条`));
    fold.appendChild(head);
    if (st.agentFoldOpen) {
      const body = el('div', 'qc-compose-fold-body');
      for (const item of act) {
        const block = el('div', 'qc-agent-block');
        const row = el('div', 'qc-agent-row qc-agent-row-' + item.kind);
        row.textContent = formatAgentRow(item);
        block.appendChild(row);
        if (item.kind === 'tool_done' && item.snippetText) {
          const cap = el('div', 'qc-snippet-cap', item.snippetPath ? item.snippetPath.split(/[/\\]/).pop() ?? '' : '');
          block.appendChild(cap);
          const pre = el('pre', 'qc-tool-snippet');
          pre.textContent = item.snippetText;
          block.appendChild(pre);
        }
        body.appendChild(block);
      }
      fold.appendChild(body);
    }
    composeFoldEl = fold;
  }

  const chat = el('div', 'qc-chat');
  const msgs = sid ? st.messagesBySession[sid] ?? [] : [];
  const OUT = '<<OUTPUT>>';
  for (const m of msgs) {
    if (m.role === 'assistant') {
      const turn = el('div', 'qc-assistant-turn');
      const bubble = el('div', 'qc-msg qc-msg-assistant');
      const textOnly = m.parts
        .filter((x) => x.type === 'text' || x.type === 'thinking')
        .map((x) => (x as { text: string }).text)
        .join('\n');
      const streamingThis = st.streaming?.sessionId === sid && st.streaming?.id === m.id;
      if (streamingThis) {
        const raw = st.streaming?.buf ?? '';
        const idx = raw.indexOf(OUT);
        const thinkBar = el('div', 'qc-stream-thinking');
        const afterOut =
          idx === -1 ? '' : raw.slice(idx + OUT.length).replace(/^[\r\n]+/, '');
        if (idx === -1) {
          thinkBar.textContent = raw;
        } else {
          thinkBar.textContent = raw.slice(0, idx).trimEnd();
        }
        if (!thinkBar.textContent) thinkBar.style.display = 'none';
        turn.appendChild(thinkBar);
        const outTrim = afterOut.trim();
        if (outTrim.length > 0) {
          const contentBub = el('div', 'qc-msg qc-msg-assistant qc-msg-streaming');
          contentBub.textContent = afterOut;
          turn.appendChild(contentBub);
        }
      } else {
        bubble.classList.add('qc-msg-md');
        for (const part of m.parts) {
          if (part.type === 'thinking') {
            const det = document.createElement('details');
            det.className = 'qc-thinking';
            const sum = document.createElement('summary');
            sum.textContent = '思考过程';
            det.appendChild(sum);
            const body = el('div', 'qc-thinking-body');
            body.innerHTML = renderAssistantMarkdown((part as { text: string }).text);
            det.appendChild(body);
            bubble.appendChild(det);
          } else if (part.type === 'text') {
            const block = el('div', 'qc-md-block');
            block.innerHTML = renderAssistantMarkdown((part as { text: string }).text);
            bubble.appendChild(block);
          } else if (part.type === 'tool_trace') {
            const tp = part as { type: 'tool_trace'; name: string; body: string };
            const panel = el('div', 'qc-tool-trace');
            panel.appendChild(el('div', 'qc-tool-trace-head', `工具 · ${tp.name}`));
            const pre = el('pre', 'qc-tool-trace-body');
            pre.textContent = tp.body;
            panel.appendChild(pre);
            bubble.appendChild(panel);
          } else if (part.type === 'tool_result') {
            const tr = part as { type: 'tool_result'; name: string; output: string };
            const det = document.createElement('details');
            det.className = 'qc-tool-result';
            det.open = false;
            const sum = document.createElement('summary');
            sum.textContent = `工具返回 · ${tr.name}`;
            det.appendChild(sum);
            const pre = el('pre', 'qc-tool-result-body');
            pre.textContent = tr.output;
            det.appendChild(pre);
            bubble.appendChild(det);
          }
        }
        if (!bubble.childNodes.length) {
          bubble.innerHTML = renderAssistantMarkdown(textOnly);
        }
        turn.appendChild(bubble);
        if (m.quickReplies?.length && sid) {
          const qr = el('div', 'qc-quick-replies');
          for (const q of m.quickReplies) {
            const sidNow = sid;
            qr.appendChild(
              btn(q.label, () => vscode.postMessage({ type: 'sendMessage', sessionId: sidNow, text: q.payload }), q.payload)
            );
          }
          turn.appendChild(qr);
        }
      }
      chat.appendChild(turn);
    } else {
      const bubble = el('div', 'qc-msg qc-msg-' + m.role);
      const text = m.parts
        .map((x) =>
          x.type === 'text'
            ? x.text
            : x.type === 'tool_trace'
              ? `[工具 ${x.name}]`
              : x.type === 'tool_result'
                ? `[${x.name} 返回]`
                : '[image]'
        )
        .join('\n');
      bubble.textContent = text;
      chat.appendChild(bubble);
    }
  }
  main.appendChild(chat);
  main.appendChild(toolbar);
  main.appendChild(pendingBar);
  if (composeFoldEl) main.appendChild(composeFoldEl);

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
    chatAtBottom = true;
    thinkingAtBottom = true;
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
  for (const tb of root.querySelectorAll('.qc-stream-thinking')) {
    if (tb instanceof HTMLElement && tb.textContent) {
      bindThinkingStreamScrollStick(tb);
      scrollThinkingBarToBottomIfPinned(tb);
    }
  }
  const chatEl = root.querySelector('.qc-chat');
  if (chatEl instanceof HTMLElement) {
    bindChatScrollStick(chatEl);
    if (chatScrollRestoreDist !== null) {
      const d = chatScrollRestoreDist;
      suppressChatScrollStick = true;
      requestAnimationFrame(() => {
        chatEl.scrollTop = Math.max(0, chatEl.scrollHeight - chatEl.clientHeight - d);
        requestAnimationFrame(() => {
          chatEl.scrollTop = Math.max(0, chatEl.scrollHeight - chatEl.clientHeight - d);
          suppressChatScrollStick = false;
          chatAtBottom = isChatAtBottom(chatEl);
        });
      });
    } else if (chatAtBottom) {
      scrollChatToBottomIfPinned();
    } else {
      chatAtBottom = isChatAtBottom(chatEl);
    }
  }
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
      thinkingAtBottom = true;
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
    thinkingAtBottom = true;
    render();
  }
  if (msg.type === 'agentActivityClear') {
    st.agentActivityBySession[msg.sessionId] = [];
    render();
  }
  if (msg.type === 'agentActivity') {
    const arr = (st.agentActivityBySession[msg.sessionId] ??= []);
    arr.push(msg.item);
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
.qc-pending-above-chat { flex-shrink:0; display:flex; flex-direction:column; gap:6px; padding:8px 10px; border-bottom:1px solid var(--vscode-widget-border); background: var(--vscode-sideBar-background); font-size:11px;}
.qc-pending-above-chat--idle { opacity:0.85;}
.qc-pending-bar-title { font-weight:600; font-size:11px;}
.qc-pending-dropdown { max-width:100%; width:100%; box-sizing:border-box;}
.qc-pending-global-actions { display:flex; flex-wrap:wrap; gap:4px; align-items:center;}
.qc-pending-file-actions { display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:4px 0; border-top:1px solid var(--vscode-widget-border);}
.qc-pending-meta { font-size:10px; opacity:0.85; margin-right:4px;}
.qc-agent-block { margin-bottom:6px;}
.qc-snippet-cap { font-size:10px; opacity:0.9; margin-top:4px;}
.qc-tool-snippet { margin:0; padding:6px 8px; max-height:120px; overflow:auto; font-size:10px; background: var(--vscode-textCodeBlock-background); border-radius:4px; white-space:pre-wrap;}
.qc-stream-thinking { max-height:88px; overflow:auto; padding:6px 8px; margin-bottom:6px; border-radius:6px; font-size:11px; line-height:1.35; white-space:pre-wrap; opacity:0.72; background: var(--vscode-editorWidget-background); border:1px solid var(--vscode-widget-border);}
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
.qc-assistant-turn { align-self:flex-start; max-width:92%; display:flex; flex-direction:column; gap:6px;}
.qc-thinking { font-size:11px; margin-bottom:2px;}
.qc-thinking summary { cursor:pointer; user-select:none; opacity:0.9;}
.qc-thinking-body { margin-top:4px; padding:6px 8px; background: var(--vscode-textBlockQuote-background); border-radius:4px; font-size:11px;}
.qc-tool-trace { margin-top:6px; border-radius:6px; border:1px solid var(--vscode-input-border); background: var(--vscode-editorWidget-background); overflow:hidden; align-self:stretch; max-width:100%;}
.qc-tool-trace-head { padding:5px 10px; font-size:11px; font-weight:600; border-bottom:1px solid var(--vscode-widget-border); background: var(--vscode-sideBar-background); opacity:0.95;}
.qc-tool-trace-body { margin:0; padding:8px 10px; max-height:220px; overflow:auto; font-size:10px; line-height:1.4; white-space:pre-wrap; font-family: var(--vscode-editor-font-family); color: var(--vscode-foreground);}
.qc-tool-result { margin-top:6px; font-size:11px; border-radius:6px; border:1px solid var(--vscode-testing-iconPassed); background: var(--vscode-editorWidget-background); align-self:stretch; max-width:100%;}
.qc-tool-result summary { cursor:pointer; user-select:none; padding:6px 10px; font-weight:500;}
.qc-tool-result-body { margin:0; padding:8px 10px; max-height:280px; overflow:auto; font-size:10px; line-height:1.35; white-space:pre-wrap; font-family: var(--vscode-editor-font-family); border-top:1px solid var(--vscode-widget-border);}
.qc-md-block + .qc-md-block { margin-top:0.45em;}
.qc-quick-replies { display:flex; flex-wrap:wrap; gap:6px; padding-left:2px;}
.qc-msg-user { align-self:flex-end; background: var(--vscode-input-background); border:1px solid var(--vscode-input-border);}
.qc-msg-assistant { align-self:stretch; background: var(--vscode-editor-inactiveSelectionBackground);}
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
