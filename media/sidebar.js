(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const boot = document.getElementById('boot-state');
  const state = JSON.parse(boot.textContent);
  state.timeline ||= {};
  state.subagents ||= {};
  state.toolpacks ||= [];
  state.queues ||= {};
  state.approvalMode ||= 'ask';
  state.runStates ||= {};
  state.subagentProfiles ||= [];
  state.instructions ||= [];
  boot.remove();
  const local = vscode.getState() || {};
  const pages = ['chat', 'accounts', 'models', 'subagents', 'instructions', 'toolcalls'];
  let page = pages.includes(state.page) && state.page !== 'chat' ? state.page
    : pages.includes(local.page) ? local.page : 'chat';
  const closedTabs = new Set(Array.isArray(local.closedTabs) ? local.closedTabs : []);
  const saveLocal = () => vscode.setState({ page, closedTabs: [...closedTabs] });
  let pendingAccountRemoval = '';
  let pendingModelRemoval = '';
  let pendingInstructionRemoval = '';
  let openedSubagent = '';
  let changesExpanded = false;
  let attachments = [];
  let attachmentQueue = Promise.resolve();
  let attachmentsReading = 0;
  let editingEntryId = '';
  const expandedBatches = new Set();
  const batchCounts = new Map();
  const toolGlyph = tool => tool.state === 'running' ? 'progress_activity' : tool.state === 'error' ? 'error' : tool.state === 'cancelled' ? 'stop_circle' : tool.kind === 'search' ? 'search' : tool.kind === 'shell' ? 'terminal' : tool.kind === 'read' ? 'description' : 'check_circle';
  const toolLabel = tool => {
    const running = tool.state === 'running';
    if (tool.kind === 'read') return running ? 'Reading File' : 'File Read';
    if (tool.kind === 'search') return running ? 'Searching' : 'Search';
    if (tool.kind === 'shell') return running ? 'Running Command' : 'Command Run';
    return tool.title;
  };
  const tickerItem = tool => {
    const item = document.createElement('span'); item.className = 'ticker-item tool-row tool-' + tool.state;
    const glyph = icon(toolGlyph(tool));
    const name = document.createElement('span'); name.className = 'tool-row-title'; name.textContent = toolLabel(tool);
    item.append(glyph, name);
    if (tool.detail) { const detail = document.createElement('span'); detail.className = 'tool-row-detail'; detail.textContent = tool.detail.replace(/\s+/g, ' '); item.appendChild(detail); }
    return item;
  };
  const questionDrafts = new Map();
  const maxAttachments = 8;
  const maxAttachmentBytes = 10 * 1024 * 1024;
  const maxTotalBytes = 20 * 1024 * 1024;
  const isImageMime = mime => /^image\/(png|jpeg|gif|webp)$/.test(mime);
  const isTextMime = mime => mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml';
  const el = id => document.getElementById(id);
  const send = message => vscode.postMessage(message);
  const icon = name => { const span = document.createElement('span'); span.className = 'symbol'; span.textContent = name; return span; };
  const button = (label, title, action, className = 'icon-button', iconName) => {
    const result = document.createElement('button'); result.type = 'button'; result.className = className; result.title = title; result.setAttribute('aria-label', title);
    if (iconName) result.appendChild(icon(iconName)); else result.textContent = label;
    result.onclick = action; return result;
  };
  // Lists are rebuilt on every state message; only rows whose data-key is new get the entrance animation.
  const shownKeys = new Map();
  function rebuild(root, build) {
    const known = shownKeys.get(root) || new Set();
    root.textContent = ''; build();
    const current = new Set();
    for (const node of root.querySelectorAll('[data-key]')) {
      current.add(node.dataset.key);
      if (!known.has(node.dataset.key)) node.classList.add('enter');
    }
    shownKeys.set(root, current);
  }
  const keyed = (node, key) => { node.dataset.key = key; return node; };
  const providerNames = { 'codex-cli': 'Codex', 'claude-cli': 'Claude Code', 'cursor-acp': 'Cursor', 'deepseek-official': 'DeepSeek', openrouter: 'OpenRouter' };
  const accountGroups = [
    { provider: 'codex-cli', title: 'ChatGPT Accounts', icon: 'smart_toy', oauth: true },
    { provider: 'claude-cli', title: 'Claude Accounts', icon: 'neurology', oauth: true },
    { provider: 'cursor-acp', title: 'Cursor Accounts', icon: 'account_circle' },
    { provider: 'deepseek-official', title: 'DeepSeek Accounts', icon: 'water_drop' },
    { provider: 'openrouter', title: 'OpenRouter Accounts', icon: 'hub' },
  ];

  function showPage(next) {
    page = next; state.page = next; saveLocal(); send({ type: 'pageChanged', page });
    el('model-menu').hidden = true; el('model-picker').setAttribute('aria-expanded', 'false');
    for (const name of pages) el(name + '-page').hidden = name !== page;
    el('accounts').setAttribute('aria-pressed', String(page === 'accounts'));
    render();
  }

  function renderNotice() {
    const notice = el('notice');
    notice.hidden = !state.error;
    notice.textContent = state.error || '';
  }

  function renderPicker() {
    const menu = el('model-menu'); menu.textContent = '';
    const models = state.models.filter(item => item.enabled !== false);
    const selected = models.find(item => item.id === state.selectedModelId) || models[0];
    el('model-picker-label').textContent = selected ? selected.name : 'Choose model';
    el('model-picker').title = selected ? (providerNames[selected.provider] || selected.provider) : 'Choose model';
    for (const model of models) {
      const item = button('', 'Use ' + model.name, () => {
        state.selectedModelId = model.id; menu.hidden = true; el('model-picker').setAttribute('aria-expanded', 'false');
        send({ type: 'selectModel', modelId: model.id }); renderPicker();
      }, 'model-option');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(model.id === selected?.id));
      const name = document.createElement('span'); name.className = 'model-option-name'; name.textContent = model.name;
      const provider = document.createElement('span'); provider.className = 'model-option-provider'; provider.textContent = providerNames[model.provider] || model.provider;
      item.append(name, provider); menu.appendChild(item);
    }
    const selectedModel = state.models.find(item => item.id === state.selectedModelId);
    const speeds = selectedModel?.speedOptions || [];
    const efforts = selectedModel?.effortOptions || [];
    const speedControl = el('speed-control'); speedControl.hidden = !speeds.length;
    el('speed-label').textContent = state.selectedSpeed || speeds[0]?.label || 'Speed';
    const speedRoot = el('speed-options'); speedRoot.textContent = '';
    for (const speed of speeds) {
      const choice = button(speed.label, 'Use ' + speed.label + ' speed', () => { state.selectedSpeed = speed.label; closeMenus(); renderPicker(); send({ type: 'selectSpeed', value: speed.label }); }, 'menu-choice');
      choice.setAttribute('aria-selected', String((state.selectedSpeed || 'None') === speed.label)); speedRoot.appendChild(choice);
    }
    const effortControl = el('effort-control'); effortControl.hidden = !efforts.length;
    el('effort-label').textContent = state.selectedEffort || 'Default';
    const effortRoot = el('effort-options'); effortRoot.textContent = '';
    for (const effort of [{ value: '', label: 'Default' }, ...efforts.map(value => ({ value, label: value }))]) {
      const choice = button(effort.label, 'Use ' + effort.label + ' effort', () => { state.selectedEffort = effort.value; closeMenus(); renderPicker(); send({ type: 'selectEffort', value: effort.value }); }, 'menu-choice');
      choice.setAttribute('aria-selected', String((state.selectedEffort || '') === effort.value)); effortRoot.appendChild(choice);
    }
  }

  const isRunning = id => (state.runStates[id]?.state || 'idle') !== 'idle';
  const runDot = () => { const dot = document.createElement('span'); dot.className = 'run-dot'; dot.title = 'Running'; dot.setAttribute('aria-label', 'Running'); return dot; };

  function closeTab(session) {
    closedTabs.add(session.id); saveLocal();
    if (session.id === state.activeSessionId) {
      const next = state.sessions.find(item => !closedTabs.has(item.id));
      send(next ? { type: 'selectSession', sessionId: next.id } : { type: 'newSession' });
    }
    renderSessions();
  }

  function renderSessions() {
    const root = el('sessions');
    const menu = el('recent-menu'); menu.textContent = '';
    if (!state.sessions.length) { rebuild(root, () => { const empty = document.createElement('div'); empty.className = 'session-empty'; empty.textContent = 'New chat'; root.appendChild(empty); }); return; }
    const openTabs = state.sessions.filter(item => !closedTabs.has(item.id) || item.id === state.activeSessionId);
    const visible = openTabs.slice(0, 2);
    const active = openTabs.find(item => item.id === state.activeSessionId);
    const third = active && !visible.some(item => item.id === active.id) ? active : openTabs[2];
    if (third) visible.push(third);
    rebuild(root, () => {
      for (const session of visible) {
        const row = keyed(document.createElement('div'), 'session:' + session.id); row.className = 'session-row';
        const pick = button(session.name, 'Open ' + session.name, () => send({ type: 'selectSession', sessionId: session.id }), 'session-button');
        pick.classList.toggle('active', session.id === state.activeSessionId);
        pick.setAttribute('aria-pressed', String(session.id === state.activeSessionId));
        if (isRunning(session.id)) pick.prepend(runDot());
        row.append(pick, button('', 'Close ' + session.name, () => closeTab(session), 'icon-button tab-close', 'close'));
        root.appendChild(row);
      }
    });
    for (const session of state.sessions) {
      const row = document.createElement('div'); row.className = 'recent-row';
      const open = button(session.name, 'Open ' + session.name, () => { closedTabs.delete(session.id); saveLocal(); send({ type: 'selectSession', sessionId: session.id }); menu.hidden = true; el('recent-toggle').setAttribute('aria-expanded', 'false'); }, 'recent-item');
      if (isRunning(session.id)) open.prepend(runDot());
      row.appendChild(open);
      row.appendChild(button('', 'Rename ' + session.name, () => send({ type: 'renameSession', sessionId: session.id, name: '' }), 'icon-button', 'edit'));
      if (!isRunning(session.id)) {
        const remove = button('', 'Delete ' + session.name, () => {
          if (remove.classList.contains('confirming')) { send({ type: 'deleteSession', sessionId: session.id }); return; }
          remove.classList.add('confirming'); remove.title = 'Click again to delete'; remove.querySelector('.symbol').textContent = 'delete_forever';
          setTimeout(() => { if (remove.isConnected) { remove.classList.remove('confirming'); remove.title = 'Delete ' + session.name; remove.querySelector('.symbol').textContent = 'delete'; } }, 2800);
        }, 'icon-button recent-delete', 'delete');
        row.appendChild(remove);
      }
      menu.appendChild(row);
    }
  }

  const markdown = window.markdownit?.({ html: false, linkify: true, breaks: true });
  function appendLinkedText(target, value) {
    const pattern = /(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}(?::[0-9]+)?/g;
    let start = 0;
    for (const match of value.matchAll(pattern)) {
      target.appendChild(document.createTextNode(value.slice(start, match.index)));
      const raw = match[0]; const split = raw.lastIndexOf(':');
      const path = split < 0 ? raw : raw.slice(0, split);
      const line = split < 0 ? undefined : Number(raw.slice(split + 1));
      target.appendChild(button(raw, 'Open ' + path, () => send({ type: 'openFile', path, line }), 'file-ref'));
      start = match.index + raw.length;
    }
    target.appendChild(document.createTextNode(value.slice(start)));
  }

  function renderMarkdown(target, value) {
    target.textContent = '';
    if (!markdown) { appendLinkedText(target, value); return; }
    const template = document.createElement('template');
    template.innerHTML = markdown.render(value);
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (node.parentElement?.closest('a, code, pre')) continue;
      if (!/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}(?::[0-9]+)?/.test(node.textContent)) continue;
      const span = document.createElement('span'); appendLinkedText(span, node.textContent); node.replaceWith(span);
    }
    for (const link of template.content.querySelectorAll('a')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    target.appendChild(template.content);
  }

  function renderSubagentFeed(feed, agent) {
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
    const previousTop = feed.scrollTop;
    const view = `subagent:${state.activeSessionId}:${agent.id}`;
    if (feed.dataset.view !== view) { feed.textContent = ''; feed.dataset.view = view; }
    const header = document.createElement('div'); header.className = 'subagent-header';
    header.appendChild(button('', 'Back to conversation', () => { openedSubagent = ''; renderFeed(); }, 'icon-button', 'arrow_back'));
    const title = document.createElement('div'); title.className = 'subagent-header-title'; title.textContent = agent.title;
    header.appendChild(title);
    if (agent.model) { const model = document.createElement('span'); model.className = 'subagent-model'; model.textContent = agent.model; header.appendChild(model); }
    feed.textContent = ''; feed.appendChild(header);
    if (Array.isArray(agent.files)) {
      const locks = document.createElement('div'); locks.className = 'subagent-locks';
      if (agent.files.length === 0) {
        const label = document.createElement('div'); label.className = 'subagent-locks-label'; label.textContent = 'Read-only';
        const visibility = icon('visibility'); visibility.classList.add('small');
        label.prepend(visibility); locks.appendChild(label);
      } else {
        const released = agent.state !== 'running';
        if (released) locks.classList.add('released');
        const label = document.createElement('div'); label.className = 'subagent-locks-label'; label.textContent = released ? 'Lock released' : 'Locked files'; locks.appendChild(label);
        for (const file of agent.files) {
          const row = document.createElement('div'); row.className = 'subagent-lock'; row.title = file;
          const lock = icon(released ? 'lock_open' : 'lock'); lock.classList.add('small');
          const path = document.createElement('span'); path.textContent = file;
          row.append(lock, path); locks.appendChild(row);
        }
      }
      feed.appendChild(locks);
    }
    if (agent.prompt) { const prompt = document.createElement('div'); prompt.className = 'bubble user'; prompt.textContent = agent.prompt; feed.appendChild(prompt); }
    for (const message of agent.messages) {
      const item = document.createElement('div');
      if (message.role === 'tool') { item.className = 'subagent-tool'; item.textContent = message.text; }
      else { item.className = 'bubble assistant markdown'; renderMarkdown(item, message.text); }
      feed.appendChild(item);
    }
    if (!agent.messages.length) { const empty = document.createElement('div'); empty.className = 'subagent-empty'; empty.textContent = agent.state === 'running' ? 'Waiting for subagent output…' : 'No subagent text was provided by this provider.'; feed.appendChild(empty); }
    feed.scrollTop = nearBottom ? feed.scrollHeight : previousTop;
  }

  function renderChanges() {
    const root = el('changes');
    const diffs = state.diffs || [];
    root.hidden = !diffs.length;
    if (!diffs.length) return;
    root.classList.toggle('expanded', changesExpanded);
    const additions = diffs.reduce((sum, diff) => sum + (diff.additions || 0), 0);
    const deletions = diffs.reduce((sum, diff) => sum + (diff.deletions || 0), 0);
    el('changes-bulk').hidden = !diffs.some(diff => !diff.state || diff.state === 'pending' || diff.state === 'applied');
    el('changes-toggle').setAttribute('aria-expanded', String(changesExpanded));
    el('changes-icon').textContent = changesExpanded ? 'expand_more' : 'expand_less';
    el('changes-label').textContent = changesExpanded ? `${diffs.length} changed file${diffs.length === 1 ? '' : 's'}` : 'Changes';
    const total = el('changes-total'); total.hidden = changesExpanded; total.textContent = '';
    const add = document.createElement('span'); add.className = 'added'; add.textContent = `+${additions}`;
    const remove = document.createElement('span'); remove.className = 'deleted'; remove.textContent = `-${deletions}`;
    total.append(add, remove);
    const list = el('changes-list');
    rebuild(list, () => { if (changesExpanded) for (const diff of diffs) {
      const row = keyed(document.createElement('div'), 'diff:' + diff.id); row.className = 'change-row';
      const path = document.createElement('span'); path.className = 'change-path'; path.textContent = diff.path; path.title = diff.path;
      const counts = document.createElement('span'); counts.className = 'change-counts';
      const plus = document.createElement('span'); plus.className = 'added'; plus.textContent = `+${diff.additions || 0}`;
      const minus = document.createElement('span'); minus.className = 'deleted'; minus.textContent = `-${diff.deletions || 0}`;
      counts.append(plus, minus);
      row.append(path, counts, button('Open diff', 'Open diff for ' + diff.path, () => send({ type: 'openDiff', diffId: diff.id }), 'change-open'));
      if (!diff.state || diff.state === 'pending' || diff.state === 'applied') {
        const applied = diff.state === 'applied';
        const actions = document.createElement('div'); actions.className = 'change-actions';
        actions.append(button(applied ? 'Accept' : 'Apply', (applied ? 'Accept ' : 'Apply ') + diff.path, () => send({ type: 'applyDiff', diffId: diff.id }), 'change-action'), button(applied ? 'Undo' : 'Reject', (applied ? 'Undo ' : 'Reject ') + diff.path, () => send({ type: 'rejectDiff', diffId: diff.id }), 'change-action'));
        row.appendChild(actions);
      }
      list.appendChild(row);
    } });
  }

  function renderFeed() {
    const feed = el('feed');
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
    const sessionId = state.activeSessionId || '';
    renderChanges();
    const run = state.runStates[sessionId] || { state: 'idle' };
    const running = run.state !== 'idle';
    el('send').disabled = attachmentsReading > 0;
    el('send-chevron').hidden = !running;
    if (!running) closeSendMenu();
    renderQueue();
    el('cancel').hidden = !running;
    el('cancel').disabled = run.state === 'cancelling';
    fitComposerActions();
    const status = el('status'); status.hidden = !running; status.textContent = running ? run.label || '' : '';
    const selectedAgent = state.subagents?.[sessionId]?.[openedSubagent];
    if (selectedAgent) { renderSubagentFeed(feed, selectedAgent); return; }
    if (openedSubagent) openedSubagent = '';
    if (feed.dataset.view !== sessionId) { feed.textContent = ''; feed.dataset.view = sessionId; }
    const items = [];
    for (const entry of state.timeline?.[sessionId] || []) {
      if (entry.kind === 'tool') {
        if (entry.event.kind === 'edit' || entry.event.kind === 'subagent') continue;
        const last = items[items.length - 1];
        if (last?.kind === 'toolbatch') last.tools.push(entry.event);
        else items.push({ id: 'batch:' + entry.id, kind: 'toolbatch', tools: [entry.event] });
      } else if (entry.kind !== 'diff') items.push(entry);
    }
    const empty = feed.querySelector('.empty');
    if (!items.length && !empty) { const node = document.createElement('div'); node.className = 'empty'; node.textContent = 'Ask about your workspace or request an edit.'; feed.appendChild(node); }
    if (items.length) empty?.remove();
    for (const entry of items) {
      let node = [...feed.children].find(item => item.dataset.entryId === entry.id);
      if (!node) { node = document.createElement('div'); node.dataset.entryId = entry.id; node.className = 'feed-entry'; feed.appendChild(node); }
      if (entry.kind === 'message') {
        const editing = entry.role === 'user' && editingEntryId === entry.id;
        const signature = [entry.text, editing, running && entry.role === 'user'].join('\0');
        if (node.dataset.text !== signature) {
          node.textContent = '';
          if (editing) {
            node.className = 'feed-entry bubble user editing';
            const editor = document.createElement('div'); editor.className = 'message-editor';
            const input = document.createElement('textarea'); input.className = 'message-edit-input'; input.value = entry.text; input.setAttribute('aria-label', 'Edit message');
            const actions = document.createElement('div'); actions.className = 'message-edit-actions';
            actions.append(
              button('Cancel', 'Cancel edit', () => { editingEntryId = ''; renderFeed(); }, 'text-button'),
              button('Save', 'Save edit', () => {
                const text = input.value.trim();
                if (text) send({ type: 'editMessage', sessionId, entryId: entry.id, text });
                editingEntryId = '';
                renderFeed();
              }, 'primary-button'),
            );
            editor.append(input, actions); node.appendChild(editor);
          } else {
            node.className = 'feed-entry bubble ' + entry.role + (entry.role === 'assistant' ? ' markdown' : '');
            const content = document.createElement('div'); content.className = 'message-content';
            if (entry.role === 'assistant') renderMarkdown(content, entry.text); else content.textContent = entry.text;
            node.appendChild(content);
            if (entry.role === 'user' && !running) {
              const actions = document.createElement('div'); actions.className = 'message-actions';
              actions.appendChild(button('', 'Edit message', () => { editingEntryId = entry.id; renderFeed(); }, 'icon-button message-edit', 'edit'));
              node.appendChild(actions);
            }
          }
          node.dataset.text = signature;
        }
      } else if (entry.kind === 'toolbatch') {
        const tools = entry.tools;
        const expanded = expandedBatches.has(entry.id);
        const signature = [expanded, ...tools.map(tool => [tool.id, tool.title, tool.detail, tool.state, tool.kind].join('|'))].join('\n');
        if (node.dataset.text !== signature) {
          const opening = expanded && node.dataset.expanded !== 'true';
          node.className = 'feed-entry tool-batch';
          let head = node.firstElementChild?.classList.contains('tool-batch-head') ? node.firstElementChild : null;
          if (!head) {
            node.textContent = '';
            head = button('', '', () => { if (expandedBatches.has(entry.id)) expandedBatches.delete(entry.id); else expandedBatches.add(entry.id); renderFeed(); }, 'tool-batch-head');
            const chevron = icon('chevron_right'); chevron.classList.add('small');
            const ticker = document.createElement('span'); ticker.className = 'tool-ticker';
            const count = document.createElement('span'); count.className = 'tool-count';
            head.append(ticker, count, chevron); node.prepend(head);
          }
          while (node.children.length > 1) node.lastElementChild.remove();
          const label = (expanded ? 'Collapse ' : 'Expand ') + 'tool calls';
          head.title = label; head.setAttribute('aria-label', label); head.setAttribute('aria-expanded', String(expanded));
          head.querySelector('.symbol.small').textContent = expanded ? 'expand_more' : 'chevron_right';
          const last = tools[tools.length - 1];
          const ticker = head.querySelector('.tool-ticker');
          const live = [...ticker.children].filter(item => !item.classList.contains('leaving')).pop();
          const current = tickerItem(last); current.dataset.toolId = last.id;
          if (!live) ticker.appendChild(current);
          else if (live.dataset.toolId === last.id) {
            for (const name of [...live.classList]) if (name.startsWith('tool-') && name !== 'tool-row') live.classList.remove(name);
            live.classList.add('tool-' + last.state);
            live.replaceChildren(...current.childNodes);
          }
          else {
            live.classList.remove('entering'); live.classList.add('leaving'); live.addEventListener('animationend', () => live.remove(), { once: true });
            current.classList.add('entering'); ticker.appendChild(current);
          }
          const count = head.querySelector('.tool-count'); count.textContent = String(tools.length);
          const previousCount = batchCounts.get(entry.id); batchCounts.set(entry.id, tools.length);
          count.classList.remove('bump');
          if (previousCount !== undefined && previousCount !== tools.length) { void count.offsetWidth; count.classList.add('bump'); }
          if (expanded) {
            const list = document.createElement('div'); list.className = 'tool-batch-list' + (opening ? ' bubbling' : '');
            for (const tool of tools) {
              const row = document.createElement('div'); row.className = 'tool-row tool-' + tool.state; row.title = tool.title + (tool.detail ? ': ' + tool.detail : '');
              const glyph = icon(toolGlyph(tool));
              const name = document.createElement('span'); name.className = 'tool-row-title'; name.textContent = tool.title;
              row.append(glyph, name);
              if (tool.detail) { const detail = document.createElement('span'); detail.className = 'tool-row-detail'; detail.textContent = tool.detail.replace(/\s+/g, ' '); row.appendChild(detail); }
              list.appendChild(row);
            }
            node.appendChild(list);
          }
          node.dataset.expanded = String(expanded);
          node.dataset.text = signature;
        }
      } else if (entry.kind === 'approval') {
        const signature = entry.status;
        if (node.dataset.text !== signature) {
          node.className = 'feed-entry card approval-card approval-' + entry.status; node.textContent = '';
          const head = document.createElement('div'); head.className = 'approval-title';
          head.append(icon(entry.status === 'pending' ? 'shield' : entry.status === 'allowed' ? 'check_circle' : 'block'));
          const label = document.createElement('span'); label.textContent = entry.status === 'pending' ? entry.title : entry.status === 'allowed' ? 'Allowed' : 'Rejected'; head.appendChild(label);
          node.appendChild(head);
          const detail = document.createElement('pre'); detail.className = 'approval-detail'; detail.textContent = entry.detail; node.appendChild(detail);
          if (entry.status === 'pending') {
            const actions = document.createElement('div'); actions.className = 'approval-actions';
            const id = entry.id.slice('approval:'.length);
            actions.append(button('Allow once', 'Allow once', () => send({ type: 'approvalResponse', id, allow: true }), 'text-button approval-allow'),
              button('Reject', 'Reject', () => send({ type: 'approvalResponse', id, allow: false }), 'text-button approval-reject'));
            node.appendChild(actions);
          }
          node.dataset.text = signature;
        }
      } else if (entry.kind === 'question') {
        const signature = JSON.stringify([entry.status, entry.questions, entry.answers]);
        if (node.dataset.text !== signature) {
          node.className = 'feed-entry card question-card' + (entry.status === 'pending' ? ' question-pending' : ' question-resolved'); node.textContent = '';
          const qid = entry.id.slice('question:'.length);
          const draftKey = sessionId + '\0' + qid;
          const drafts = questionDrafts.get(draftKey) || [];
          if (entry.status === 'pending') {
            const ready = () => {
              for (let i = 0; i < entry.questions.length; i++) {
                const draft = drafts[i];
                if (!draft || (draft.option === undefined && !(typeof draft.other === 'string' && draft.other.trim()))) return false;
              }
              return true;
            };
            const submit = () => {
              if (!ready()) return;
              const answers = entry.questions.map((question, i) => {
                const draft = drafts[i];
                return draft.option !== undefined ? question.options[draft.option]?.label || '' : draft.other.trim();
              });
              send({ type: 'questionResponse', id: qid, answers });
            };
            entry.questions.forEach((question, questionIndex) => {
              const block = document.createElement('section'); block.className = 'question-block';
              if (question.header) { const chip = document.createElement('div'); chip.className = 'question-header'; chip.textContent = question.header; block.appendChild(chip); }
              const prompt = document.createElement('div'); prompt.className = 'question-prompt'; prompt.textContent = question.question; block.appendChild(prompt);
              const group = document.createElement('div'); group.className = 'question-options'; group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-label', question.question);
              const draft = drafts[questionIndex] || {};
              const choices = [...(question.options || []), { label: 'Other…' }];
              const otherIndex = choices.length - 1;
              const radios = [];
              const expand = document.createElement('div'); expand.className = 'question-other-expand';
              const clip = document.createElement('div'); clip.className = 'question-other-clip';
              const input = document.createElement('input'); input.className = 'question-other-input'; input.type = 'text'; input.setAttribute('aria-label', 'Your answer'); input.placeholder = 'Type your answer';
              // Selection updates the existing nodes so animations and keyboard focus survive.
              const select = (index, focusInput) => {
                const isOther = index === otherIndex;
                drafts[questionIndex] = isOther ? { other: drafts[questionIndex]?.other || '' } : { option: index };
                questionDrafts.set(draftKey, drafts);
                radios.forEach((radio, i) => { radio.classList.toggle('question-selected', i === index); radio.setAttribute('aria-checked', String(i === index)); });
                expand.classList.toggle('open', isOther); input.disabled = !isOther;
                if (isOther && focusInput) input.focus();
                updateSubmit();
              };
              choices.forEach((option, optionIndex) => {
                const selected = optionIndex === otherIndex ? draft.other !== undefined : draft.option === optionIndex;
                const choice = document.createElement('button'); choice.type = 'button'; choice.className = 'question-option' + (selected ? ' question-selected' : ''); choice.setAttribute('role', 'radio'); choice.setAttribute('aria-checked', selected ? 'true' : 'false'); choice.style.setProperty('--i', String(questionIndex * 6 + optionIndex));
                const dot = document.createElement('span'); dot.className = 'question-radio'; dot.setAttribute('aria-hidden', 'true');
                const content = document.createElement('span'); content.className = 'question-option-copy';
                const label = document.createElement('span'); label.className = 'question-option-label'; label.textContent = option.label; content.appendChild(label);
                if (option.description) { const desc = document.createElement('span'); desc.className = 'question-option-description'; desc.textContent = option.description; content.appendChild(desc); }
                choice.append(dot, content);
                choice.onclick = () => select(optionIndex, true);
                choice.onkeydown = event => {
                  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                  event.preventDefault();
                  const target = (optionIndex + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length;
                  radios[target].focus(); select(target, false);
                };
                radios.push(choice); group.appendChild(choice);
              });
              input.value = draft.other || ''; input.disabled = draft.other === undefined; expand.classList.toggle('open', draft.other !== undefined);
              input.oninput = () => { drafts[questionIndex] = { other: input.value }; questionDrafts.set(draftKey, drafts); updateSubmit(); };
              input.onkeydown = event => { if (event.key === 'Enter' && ready()) { event.preventDefault(); submit(); } };
              clip.appendChild(input); expand.appendChild(clip); group.appendChild(expand);
              block.appendChild(group); node.appendChild(block);
            });
            const actions = document.createElement('div'); actions.className = 'question-actions';
            const skip = button('Skip', 'Skip these questions', () => send({ type: 'questionResponse', id: qid, answers: null }), 'text-button question-skip');
            const submitButton = button('Submit', 'Submit answers', submit, 'primary-button question-submit');
            const updateSubmit = () => { const wasDisabled = submitButton.disabled; submitButton.disabled = !ready(); if (wasDisabled && !submitButton.disabled) submitButton.classList.add('question-submit-ready'); };
            updateSubmit(); actions.append(skip, submitButton); node.appendChild(actions);
          } else {
            questionDrafts.delete(draftKey);
            const head = document.createElement('div'); head.className = 'question-title'; head.textContent = entry.status === 'answered' ? 'Questions answered' : 'Questions skipped'; node.appendChild(head);
            (entry.questions || []).forEach((question, i) => {
              const block = document.createElement('div'); block.className = 'question-summary';
              const prompt = document.createElement('div'); prompt.className = 'question-summary-prompt'; prompt.textContent = question.question;
              const answer = document.createElement('div'); answer.className = 'question-answer'; answer.textContent = entry.answers?.[i] || '';
              block.append(prompt, answer); node.appendChild(block);
            });
          }
          node.dataset.text = signature;
        }
      } else if (entry.kind === 'subagent') {
        const agent = state.subagents?.[sessionId]?.[entry.agentId];
        if (!agent) { node.remove(); continue; }
        const signature = [agent.title, agent.model, agent.state, agent.messages.length].join('|');
        if (node.dataset.text !== signature) {
          node.className = 'feed-entry subagent-entry'; node.textContent = '';
          const open = button('', 'Open subagent ' + agent.title, () => { openedSubagent = agent.id; renderFeed(); }, 'subagent-button');
          const stateIcon = icon(agent.state === 'running' ? 'progress_activity' : agent.state === 'error' ? 'error' : agent.state === 'cancelled' ? 'stop_circle' : 'check_circle');
          if (agent.state === 'running') stateIcon.classList.add('spinning');
          open.append(stateIcon);
          const label = document.createElement('span'); label.className = 'subagent-label'; label.textContent = agent.title;
          open.appendChild(label);
          if (agent.model) { const model = document.createElement('span'); model.className = 'subagent-model'; model.textContent = agent.model; open.appendChild(model); }
          open.append(icon('chevron_right')); node.appendChild(open);
          const detail = document.createElement('div'); detail.className = 'subagent-detail'; detail.textContent = agent.state === 'running' ? 'Working…' : agent.state === 'error' ? 'Failed' : agent.state === 'cancelled' ? 'Cancelled' : agent.messages.length ? 'View subagent chat' : 'Completed'; node.appendChild(detail);
          node.dataset.text = signature;
        }
      }
    }
    if (nearBottom) feed.scrollTop = feed.scrollHeight;
  }

  function accountRow(account) {
    const row = keyed(document.createElement('div'), 'account:' + account.id); row.className = 'account-row';
    const main = document.createElement('div'); main.className = 'row-main';
    const title = document.createElement('div'); title.className = 'row-title'; title.append(document.createTextNode(account.label + (account.email ? ' (' + account.email + ')' : '')));
    if (account.isDefault) { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = 'Default'; title.appendChild(badge); }
    const subtitle = document.createElement('div'); subtitle.className = 'row-subtitle'; subtitle.textContent = account.authType === 'oauth' ? 'Browser sign-in' : 'API key';
    main.append(title, subtitle); row.appendChild(main);
    const actions = document.createElement('div'); actions.className = 'row-actions';
    if (!account.isDefault) actions.appendChild(button('', 'Make default', () => send({ type: 'setDefaultAccount', provider: account.provider, accountId: account.id }), 'icon-button', 'star'));
    const remove = button('', pendingAccountRemoval === account.id ? 'Confirm removal' : 'Remove account', () => {
      if (pendingAccountRemoval === account.id) { pendingAccountRemoval = ''; send({ type: 'removeAccount', accountId: account.id }); }
      else { pendingAccountRemoval = account.id; renderAccounts(); }
    }, 'icon-button', pendingAccountRemoval === account.id ? 'delete_forever' : 'delete');
    actions.appendChild(remove); row.appendChild(actions); return row;
  }

  function renderAccounts() {
    const root = el('account-groups');
    rebuild(root, () => {
    for (const group of accountGroups) {
      const section = keyed(document.createElement('section'), 'group:' + group.provider); section.className = 'provider-group';
      const heading = document.createElement('div'); heading.className = 'group-heading'; heading.appendChild(icon(group.icon));
      const title = document.createElement('h2'); title.textContent = group.title; heading.appendChild(title);
      heading.appendChild(button('', 'View ' + providerNames[group.provider] + ' usage in your browser', () => send({ type: 'viewProviderUsage', provider: group.provider }), 'icon-button', 'open_in_new'));
      section.appendChild(heading);
      if (group.provider === 'cursor-acp') {
        if (state.cursor.connected) {
          const row = keyed(document.createElement('div'), 'account:cursor'); row.className = 'account-row';
          const main = document.createElement('div'); main.className = 'row-main';
          const line = document.createElement('div'); line.className = 'row-title'; line.append(document.createTextNode(state.cursor.label || 'Cursor account'));
          const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = 'Active'; line.appendChild(badge);
          const sub = document.createElement('div'); sub.className = 'row-subtitle'; sub.textContent = 'Browser sign-in'; main.append(line, sub); row.appendChild(main); section.appendChild(row);
        } else { const empty = document.createElement('div'); empty.className = 'empty-row'; empty.textContent = state.cursor.busy ? 'Complete sign-in in your browser…' : 'No Cursor account connected'; section.appendChild(empty); }
        const footer = document.createElement('div'); footer.className = 'group-footer';
        const action = button(state.cursor.connected ? 'Disconnect' : state.cursor.busy ? 'Connecting…' : 'Connect Cursor', state.cursor.connected ? 'Disconnect Cursor' : 'Sign in with Cursor', () => send({ type: state.cursor.connected ? 'cursorLogout' : 'cursorLogin' }), 'secondary-button');
        action.disabled = !!state.cursor.busy; footer.appendChild(action);
        footer.appendChild(button('Refresh', 'Refresh Cursor account status', () => send({ type: 'refreshAccounts' }), 'text-button'));
        if (state.cursor.authUrl) footer.appendChild(button('Open sign-in page', 'Open Cursor sign-in page', () => send({ type: 'openAuthUrl', url: state.cursor.authUrl }), 'text-button'));
        section.appendChild(footer);
      } else {
        const accounts = state.accounts.filter(account => account.provider === group.provider);
        if (accounts.length) for (const account of accounts) section.appendChild(accountRow(account));
        else { const empty = document.createElement('div'); empty.className = 'empty-row'; empty.textContent = 'No accounts added'; section.appendChild(empty); }
        const footer = document.createElement('div'); footer.className = 'group-footer';
        footer.appendChild(button(group.oauth ? 'Connect account' : 'Add API key', 'Add an account for ' + group.title, () => openAccountForm(group), 'text-button'));
        section.appendChild(footer);
      }
      root.appendChild(section);
    }
    const legacy = state.accounts.filter(account => account.provider === 'openai' || account.provider === 'anthropic');
    if (legacy.length) {
      const section = keyed(document.createElement('section'), 'group:legacy'); section.className = 'provider-group';
      const heading = document.createElement('div'); heading.className = 'group-heading';
      const title = document.createElement('h2'); title.textContent = 'Previous API accounts'; heading.appendChild(title); section.appendChild(heading);
      for (const account of legacy) section.appendChild(accountRow(account));
      root.appendChild(section);
    }
    });
  }

  function openAccountForm(group) {
    showPage('accounts');
    const form = el('account-form'); form.hidden = false; form.dataset.provider = group.provider; form.dataset.oauth = group.oauth ? 'true' : 'false';
    el('account-form-title').textContent = (group.oauth ? 'Connect ' : 'Add ') + group.title.replace(' Accounts', '') + ' account';
    el('account-form-help').textContent = group.oauth ? 'Continue in your browser with your subscription.' : 'Your key is stored in VS Code SecretStorage.';
    el('account-key-field').hidden = !!group.oauth; el('account-key').required = !group.oauth;
    el('account-submit').textContent = group.oauth ? 'Continue in browser' : 'Save account';
    el('account-name').value = ''; el('account-email').value = ''; el('account-key').value = '';
    form.scrollIntoView({ block: 'nearest' }); el('account-name').focus();
  }

  // Settings writes can take seconds, so drop the row immediately and hide it from stale host state until the host confirms.
  const removingModels = new Set();
  function removeModelNow(name) {
    removingModels.add(name);
    state.models = state.models.filter(item => item.name !== name);
    if (state.selectedModelId === name) state.selectedModelId = state.models.find(item => item.enabled !== false)?.id || '';
    send({ type: 'removeModel', name });
    renderModels(); renderPicker();
  }

  function modelRow(model) {
    const row = keyed(document.createElement('div'), 'model:' + model.name); row.className = 'model-row';
    const main = document.createElement('div'); main.className = 'row-main';
    const title = document.createElement('div'); title.className = 'row-title'; title.append(document.createTextNode(model.name));
    if (model.id === state.selectedModelId) { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = 'Selected'; title.appendChild(badge); }
    const subtitle = document.createElement('div'); subtitle.className = 'row-subtitle'; subtitle.textContent = (providerNames[model.provider] || model.provider) + ' · ' + model.backend;
    if (model.speedOptions?.length) subtitle.textContent += ' · ' + model.speedOptions.length + ' speeds';
    if (model.effortOptions?.length) subtitle.textContent += ' · ' + model.effortOptions.length + ' efforts';
    main.append(title, subtitle); row.appendChild(main);
    const actions = document.createElement('div'); actions.className = 'row-actions';
    actions.appendChild(button('', 'Edit model', () => openModelForm(model), 'icon-button', 'edit'));
    actions.appendChild(button('', pendingModelRemoval === model.name ? 'Confirm removal' : 'Remove model', () => {
      if (pendingModelRemoval === model.name) { pendingModelRemoval = ''; removeModelNow(model.name); }
      else { pendingModelRemoval = model.name; renderModels(); }
    }, 'icon-button', pendingModelRemoval === model.name ? 'delete_forever' : 'delete'));
    row.appendChild(actions); return row;
  }

  function renderModels() {
    const root = el('model-list');
    const configured = state.models;
    rebuild(root, () => {
      if (!configured.length) { const empty = document.createElement('div'); empty.className = 'empty-row'; empty.textContent = 'No models configured'; root.appendChild(empty); }
      else for (const model of configured) root.appendChild(modelRow(model));
    });
  }

  function renderSubagents() {
    const root = el('subagent-list');
    const profiles = state.subagentProfiles || [];
    rebuild(root, () => {
    if (!profiles.length) { const empty = document.createElement('div'); empty.className = 'empty-row'; empty.textContent = 'No subagents yet'; root.appendChild(empty); return; }
    for (const profile of profiles) {
      const row = keyed(document.createElement('div'), 'subagent:' + profile.name); row.className = 'model-row';
      const main = document.createElement('div'); main.className = 'row-main';
      const title = document.createElement('div'); title.className = 'row-title'; title.textContent = profile.name;
      const meta = document.createElement('div'); meta.className = 'row-meta';
      meta.textContent = [profile.model, profile.effort, profile.speed, profile.mode === 'edit' ? 'can edit' : 'read-only'].filter(Boolean).join(' · ');
      main.append(title, meta);
      const actions = document.createElement('div'); actions.className = 'row-actions';
      actions.append(button('', 'Edit ' + profile.name, () => openSubagentForm(profile), 'icon-button', 'edit'), button('', 'Remove ' + profile.name, () => send({ type: 'removeSubagent', name: profile.name }), 'icon-button', 'delete'));
      row.append(main, actions); root.appendChild(row);
    }
    });
  }

  function renderInstructions() {
    const root = el('instruction-list');
    const items = state.instructions || [];
    rebuild(root, () => {
    if (!items.length) { const empty = document.createElement('div'); empty.className = 'empty-row'; empty.textContent = 'No rules or skills yet'; root.appendChild(empty); return; }
    const groups = [['Workspace rules', 'workspace', 'rule'], ['Workspace skills', 'workspace', 'skill'], ['Global rules', 'global', 'rule'], ['Global skills', 'global', 'skill']];
    for (const [label, scope, kind] of groups) {
      const members = items.filter(item => item.scope === scope && item.kind === kind);
      if (!members.length) continue;
      const heading = document.createElement('div'); heading.className = 'instruction-group'; heading.textContent = label; root.appendChild(heading);
      for (const item of members) {
        const row = keyed(document.createElement('div'), 'instruction:' + item.id); row.className = 'model-row';
        const main = document.createElement('div'); main.className = 'row-main';
        const title = document.createElement('div'); title.className = 'row-title'; title.textContent = item.name;
        const detail = document.createElement('div'); detail.className = 'row-subtitle'; detail.textContent = item.description || item.path;
        detail.title = item.path;
        main.append(title, detail);
        const confirming = pendingInstructionRemoval === item.id;
        const actions = document.createElement('div'); actions.className = 'row-actions';
        actions.append(
          button('', 'Edit ' + item.name, () => openInstructionForm(item.kind, item), 'icon-button', 'edit'),
          button('', 'Open ' + item.name + ' in the editor', () => send({ type: 'openInstruction', id: item.id }), 'icon-button', 'open_in_new'),
          button('', confirming ? 'Confirm removal' : 'Remove ' + item.name, () => {
            if (confirming) { pendingInstructionRemoval = ''; send({ type: 'removeInstruction', id: item.id }); }
            else { pendingInstructionRemoval = item.id; renderInstructions(); }
          }, 'icon-button', confirming ? 'delete_forever' : 'delete'));
        row.append(main, actions); root.appendChild(row);
      }
    }
    });
  }

  function updateInstructionForm() {
    const form = el('instruction-form'); const editing = !!form.dataset.id; const skill = form.dataset.kind === 'skill';
    el('instruction-scope-field').hidden = editing;
    el('instruction-file-field').hidden = editing || skill;
    el('instruction-name-field').hidden = editing || !skill;
    el('instruction-description-field').hidden = editing || !skill;
    el('instruction-content-label').textContent = editing ? 'File contents' : skill ? 'Instructions' : 'Rules';
    if (!editing && !skill) {
      const files = el('instruction-scope').value === 'global' ? ['AGENTS.md'] : ['AGENTS.md', 'AGENTS.local.md', 'CLAUDE.md', 'CLAUDE.local.md'];
      fillSelect(el('instruction-file'), files.map(value => ({ value, label: value })), el('instruction-file').value);
    }
  }

  function openInstructionForm(kind, item) {
    showPage('instructions');
    const form = el('instruction-form'); form.hidden = false; form.dataset.kind = kind; form.dataset.id = item ? item.id : '';
    el('instruction-form-title').textContent = (item ? 'Edit ' : 'Add ') + kind + (item ? ': ' + item.name : '');
    el('instruction-scope').value = 'workspace'; el('instruction-name').value = ''; el('instruction-description').value = '';
    el('instruction-content').value = ''; el('instruction-content').disabled = !!item;
    updateInstructionForm();
    if (item) send({ type: 'readInstruction', id: item.id });
    form.scrollIntoView({ block: 'nearest' });
    (item ? el('instruction-content') : kind === 'skill' ? el('instruction-name') : el('instruction-content')).focus();
  }

  function renderToolpacks() {
    const root = el('toolpack-list');
    const error = el('toolpack-error'); error.hidden = !state.toolpackError; error.textContent = state.toolpackError || '';
    const packs = state.toolpacks || [];
    rebuild(root, () => {
    if (!packs.length) { const empty = document.createElement('div'); empty.className = 'empty-row'; empty.textContent = 'No toolpacks added'; root.appendChild(empty); return; }
    for (const pack of packs) {
      const row = keyed(document.createElement('div'), 'toolpack:' + pack.id); row.className = 'model-row toolpack-row';
      const main = document.createElement('div'); main.className = 'row-main';
      const title = document.createElement('div'); title.className = 'row-title'; title.textContent = pack.id;
      const badge = document.createElement('span'); badge.className = 'badge toolpack-state toolpack-state-' + pack.state; badge.textContent = pack.state; title.appendChild(badge);
      if (pack.state === 'starting') { const dot = document.createElement('span'); dot.className = 'toolpack-dot'; dot.setAttribute('aria-hidden', 'true'); badge.prepend(dot); }
      main.appendChild(title);
      if (pack.description) { const description = document.createElement('div'); description.className = 'row-subtitle'; description.textContent = pack.description; main.appendChild(description); }
      if (pack.status) { const status = document.createElement('div'); status.className = 'toolpack-status'; status.textContent = pack.status; main.appendChild(status); }
      if (pack.tools?.length) { const tools = document.createElement('div'); tools.className = 'toolpack-tools'; for (const tool of pack.tools) { const chip = document.createElement('span'); chip.className = 'toolpack-chip'; chip.textContent = tool.name; chip.title = tool.description || ''; tools.appendChild(chip); } main.appendChild(tools); }
      if (pack.error) { const detail = document.createElement('div'); detail.className = 'toolpack-detail-error'; detail.textContent = pack.error; main.appendChild(detail); }
      if (pack.logs?.length) { const logs = document.createElement('details'); logs.className = 'toolpack-logs'; const summary = document.createElement('summary'); summary.textContent = 'Logs'; logs.appendChild(summary); const content = document.createElement('pre'); content.textContent = pack.logs.slice(-100).join('\n'); logs.appendChild(content); main.appendChild(logs); }
      const actions = document.createElement('div'); actions.className = 'row-actions toolpack-actions';
      actions.appendChild(button(pack.enabled ? 'Disable' : 'Enable', pack.enabled ? 'Disable toolpack' : 'Enable toolpack', () => send({ type: 'toolpackAction', id: pack.id, action: pack.enabled ? 'disable' : 'enable' }), 'text-button'));
      if (pack.enabled) actions.appendChild(button('Reload', 'Reload toolpack', () => send({ type: 'toolpackAction', id: pack.id, action: 'reload' }), 'text-button'));
      actions.appendChild(button('', 'Remove toolpack', () => send({ type: 'toolpackAction', id: pack.id, action: 'remove' }), 'icon-button', 'delete'));
      row.append(main, actions); root.appendChild(row);
    }
    });
  }

  function fillSelect(select, items, current) {
    select.textContent = '';
    for (const item of items) { const option = document.createElement('option'); option.value = item.value; option.textContent = item.label; select.appendChild(option); }
    select.value = items.some(item => item.value === current) ? current : items[0]?.value ?? '';
  }

  function updateSubagentOptions(profile) {
    const model = state.models.find(item => item.id === el('subagent-model').value);
    fillSelect(el('subagent-effort'), [{ value: '', label: 'Default' }, ...(model?.effortOptions || []).map(value => ({ value, label: value }))], profile?.effort ?? el('subagent-effort').value);
    const speeds = model?.speedOptions || [];
    el('subagent-speed').parentElement.hidden = !speeds.length;
    fillSelect(el('subagent-speed'), [{ value: '', label: 'Default' }, ...speeds.map(item => ({ value: item.label, label: item.label }))], profile?.speed ?? el('subagent-speed').value);
  }

  function openSubagentForm(profile) {
    showPage('subagents');
    const form = el('subagent-form'); form.hidden = false; form.dataset.originalName = profile ? profile.name : '';
    el('subagent-form-title').textContent = profile ? 'Edit subagent' : 'Add subagent';
    el('subagent-name').value = profile?.name || '';
    el('subagent-description').value = profile?.description || '';
    fillSelect(el('subagent-model'), state.models.filter(item => item.enabled !== false).map(item => ({ value: item.id, label: item.name })), profile?.model);
    el('subagent-mode').value = profile?.mode || 'read-only';
    updateSubagentOptions(profile);
  }

  function updateModelSources() {
    const provider = el('model-provider').value;
    const cursor = provider === 'cursor-acp';
    el('model-backend-field').hidden = cursor;
    el('model-cursor-field').hidden = !cursor;
    const cursorSelect = el('model-cursor-backend'); const previousCursor = cursorSelect.value;
    cursorSelect.textContent = '';
    const entries = [{ value: 'auto', name: 'Auto' }, ...(state.cursorBackends || []).filter(item => item.value !== 'auto')];
    const seen = new Set();
    for (const entry of entries) { if (seen.has(entry.value)) continue; seen.add(entry.value); const option = document.createElement('option'); option.value = entry.value; option.textContent = entry.name; cursorSelect.appendChild(option); }
    if (seen.has(previousCursor)) cursorSelect.value = previousCursor;
    const account = el('model-account'); const previousAccount = account.value;
    account.textContent = '';
    const options = cursor ? [{ value: 'cursor-login', label: 'Cursor sign-in' }] : [
      { value: 'default', label: 'Default account for provider' },
      ...state.accounts.filter(item => item.provider === provider).map(item => ({ value: item.id, label: item.label + (item.email ? ' (' + item.email + ')' : '') })),
    ];
    for (const item of options) { const option = document.createElement('option'); option.value = item.value; option.textContent = item.label; account.appendChild(option); }
    if (options.some(item => item.value === previousAccount)) account.value = previousAccount;
    el('model-form-help').textContent = cursor ? 'Cursor models load after your first chat.' : provider === 'codex-cli' || provider === 'claude-cli' ? 'Use default or enter a model ID.' : 'Enter the provider model ID.';
    const nativeSpeed = provider === 'codex-cli' || provider === 'claude-cli';
    el('model-speed-options').placeholder = nativeSpeed ? (provider === 'codex-cli' ? 'Fast, Ultrafast' : 'Fast') : 'Fast=model-id';
    el('model-speed-help').textContent = nativeSpeed ? 'Enter Fast' + (provider === 'codex-cli' ? ' or Ultrafast' : '') + '. Speed settings use the base model ID. None uses standard speed.' : 'Each choice routes to a separate available model ID. The bundled DSH API adapter does not expose speed tiers.';
  }

  function openModelForm(model) {
    showPage('models');
    const form = el('model-form'); form.hidden = false; form.dataset.originalName = model ? model.name : '';
    el('model-form-title').textContent = model ? 'Edit model' : 'Add model';
    el('model-name').value = model ? model.name : '';
    el('model-provider').value = model ? model.provider : '';
    el('model-backend').value = model && model.provider !== 'cursor-acp' ? model.backend : '';
    el('model-speed-options').value = model?.speedOptions?.filter(item => item.label !== 'None').map(item => model.provider === 'codex-cli' || model.provider === 'claude-cli' ? item.label : item.label + '=' + item.backend).join(', ') || '';
    el('model-effort-options').value = model?.effortOptions?.join(', ') || '';
    updateModelSources();
    if (model) { if (model.provider === 'cursor-acp') el('model-cursor-backend').value = model.backend; el('model-account').value = model.account || (model.provider === 'cursor-acp' ? 'cursor-login' : 'default'); }
    form.scrollIntoView({ block: 'nearest' }); el('model-name').focus();
  }

  function closeSendMenu() { el('send-menu').hidden = true; el('send').setAttribute('aria-expanded', 'false'); }

  function renderQueue() {
    const list = el('queue'); const items = state.queues?.[state.activeSessionId || ''] || [];
    list.hidden = !items.length;
    rebuild(list, () => items.forEach((text, index) => {
      const chip = keyed(document.createElement('div'), 'queue:' + text); chip.className = 'queue-item'; chip.style.setProperty('--i', String(index));
      chip.append(icon('schedule_send'));
      const label = document.createElement('span'); label.className = 'queue-text'; label.textContent = text; label.title = text; chip.appendChild(label);
      chip.appendChild(button('', 'Remove queued message', () => send({ type: 'unqueue', sessionId: state.activeSessionId, index }), 'icon-button', 'close'));
      list.appendChild(chip);
    }));
  }

  function placeModelMenu() {
    const menu = el('model-menu');
    if (menu.hidden) return;
    const rect = el('model-picker').closest('.model-picker-wrap').getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 20), margin = 8;
    const wasFlipped = menu.classList.contains('flip');
    menu.style.left = '';
    const flip = rect.right - width < margin;
    menu.classList.toggle('flip', flip);
    if (flip && rect.left + width > window.innerWidth - margin) menu.style.left = (window.innerWidth - margin - width - rect.left) + 'px';
    if (flip !== wasFlipped) { menu.style.animation = 'none'; void menu.offsetWidth; menu.style.animation = ''; }
  }
  window.addEventListener('resize', placeModelMenu);

  function closeMenus() {
    for (const [menuId, buttonId] of [['model-menu', 'model-picker'], ['speed-options', 'speed-picker'], ['effort-options', 'effort-picker']]) {
      el(menuId).hidden = true; el(buttonId).setAttribute('aria-expanded', 'false');
    }
  }

  function renderApproval() {
    const mode = state.approvalMode;
    const toggle = el('approval');
    const info = {
      ask: ['Ask approval', 'shield', 'Ask before running tools. Click for "Approve for me".'],
      auto: ['Approve for me', 'bolt', 'Routine actions run automatically; risky ones still ask. Click for Full access.'],
      full: ['Full access', 'warning', 'No approval prompts, unrestricted file and network access. Click to go back to Ask approval.'],
    }[mode] || ['Ask approval', 'shield', 'Ask before running tools.'];
    toggle.setAttribute('aria-pressed', String(mode !== 'ask')); toggle.title = info[2]; toggle.setAttribute('aria-label', info[2]);
    el('approval-label').textContent = info[0];
    el('approval-icon').textContent = info[1];
    fitComposerActions();
  }

  const popEasing = 'cubic-bezier(.34, 1.56, .64, 1)';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  function fitComposerActions() {
    const actions = el('compose-actions'); if (!actions.clientWidth) return;
    const sendGroup = el('compose-send'), cancel = el('cancel'), approval = el('approval');
    const wasCompact = actions.classList.contains('compact');
    const first = cancel.hidden ? undefined : cancel.getBoundingClientRect();
    if (wasCompact) { actions.classList.remove('compact'); sendGroup.prepend(cancel); }
    const compact = approval.offsetWidth + sendGroup.offsetWidth + 12 > actions.clientWidth;
    if (compact) { actions.classList.add('compact'); el('compose-tools').append(cancel); }
    if (compact === wasCompact || reduceMotion.matches) return;
    if (first) {
      const last = cancel.getBoundingClientRect();
      const dx = first.left + first.width / 2 - (last.left + last.width / 2), dy = first.top + first.height / 2 - (last.top + last.height / 2);
      cancel.animate([{ transform: `translate(${dx}px, ${dy}px) scale(.7)` }, { transform: 'none' }], { duration: 520, easing: popEasing });
    }
    approval.animate([{ transform: 'scale(.82)' }, { transform: 'none' }], { duration: 440, easing: popEasing });
  }
  new ResizeObserver(fitComposerActions).observe(el('compose-actions'));

  function attachmentTotalBytes() {
    return attachments.reduce((sum, file) => sum + (file.size || 0), 0);
  }

  function readFileBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        resolve(url.slice(url.indexOf(',') + 1));
      };
      reader.onerror = () => reject(reader.error || new Error('read failed'));
      reader.readAsDataURL(file);
    });
  }

  function renderAttachments() {
    const root = el('attachments'); root.textContent = ''; root.hidden = !attachments.length;
    attachments.forEach((file, index) => {
      const item = document.createElement('div'); item.className = 'attachment';
      if (isImageMime(file.mimeType)) {
        const preview = document.createElement('img'); preview.src = `data:${file.mimeType};base64,${file.data}`; preview.alt = file.name; item.appendChild(preview);
      } else {
        const label = document.createElement('span'); label.className = 'attachment-label'; label.textContent = isTextMime(file.mimeType) ? 'Text' : 'Binary';
        const name = document.createElement('span'); name.className = 'attachment-name'; name.textContent = file.name;
        item.title = file.name; item.append(label, name);
      }
      const remove = button('', 'Remove ' + file.name, () => { attachments.splice(index, 1); renderAttachments(); renderFeed(); }, 'attachment-remove', 'close');
      item.appendChild(remove); root.appendChild(item);
    });
  }

  function addFiles(files) {
    attachmentsReading++;
    renderFeed();
    const pending = attachmentQueue.then(() => readFiles(files));
    attachmentQueue = pending.catch(error => { state.error = String(error); }).finally(() => {
      attachmentsReading--;
      renderFeed(); renderNotice();
    });
    return attachmentQueue;
  }

  async function readFiles(files) {
    if (!files.length) return;
    state.error = undefined;
    for (const file of files) {
      if (attachments.length >= maxAttachments) { state.error = `Attach up to ${maxAttachments} files.`; break; }
      if (file.size > maxAttachmentBytes) { state.error = `${file.name} must be under 10 MB.`; continue; }
      if (attachmentTotalBytes() + file.size > maxTotalBytes) { state.error = 'Total attachments must stay under 20 MB.'; break; }
      try {
        const data = await readFileBase64(file);
        attachments.push({ name: file.name, mimeType: file.type || 'application/octet-stream', data, size: file.size });
        renderAttachments();
      } catch {
        state.error = `Could not read ${file.name}.`;
      }
    }
    renderFeed();
    renderNotice();
  }

  function render() {
    el('view-title').textContent = { chat: 'Chats', accounts: 'Accounts', models: 'Models', subagents: 'Subagents', instructions: 'Rules & Skills', toolcalls: 'Custom Tool Calls' }[page];
    for (const name of ['accounts', 'models', 'subagents', 'instructions', 'toolcalls']) el(name).setAttribute('aria-pressed', String(page === name));
    renderNotice(); renderPicker(); renderApproval(); renderSessions(); renderFeed();
    if (page === 'accounts') renderAccounts();
    if (page === 'subagents') renderSubagents();
    if (page === 'instructions') renderInstructions();
    if (page === 'models') { renderModels(); if (!el('model-form').hidden) updateModelSources(); }
    if (page === 'toolcalls') renderToolpacks();
  }

  el('recent-toggle').onclick = () => { const menu = el('recent-menu'); menu.hidden = !menu.hidden; el('recent-toggle').setAttribute('aria-expanded', String(!menu.hidden)); };
  for (const [buttonId, menuId] of [['model-picker', 'model-menu'], ['speed-picker', 'speed-options'], ['effort-picker', 'effort-options']]) {
    el(buttonId).onclick = () => { const wasHidden = el(menuId).hidden; closeMenus(); el(menuId).hidden = !wasHidden; el(buttonId).setAttribute('aria-expanded', String(wasHidden)); if (menuId === 'model-menu') placeModelMenu(); };
  }
  document.addEventListener('click', event => {
    if (!event.target.closest('.recent-wrap')) { el('recent-menu').hidden = true; el('recent-toggle').setAttribute('aria-expanded', 'false'); }
    if (!event.target.closest('.model-picker-wrap') && !event.target.closest('.option-wrap')) closeMenus();
    if (!event.target.closest('.send-wrap')) closeSendMenu();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { el('recent-menu').hidden = true; el('recent-toggle').setAttribute('aria-expanded', 'false'); closeMenus(); closeSendMenu(); } });
  el('apply-all').onclick = () => send({ type: 'applyAll' });
  el('reject-all').onclick = () => send({ type: 'rejectAll' });
  el('changes-toggle').onclick = () => { changesExpanded = !changesExpanded; renderChanges(); };
  el('new').onclick = () => { showPage('chat'); send({ type: 'newSession' }); };
  el('accounts').onclick = () => showPage(page === 'accounts' ? 'chat' : 'accounts');
  el('models').onclick = () => showPage('models');
  document.querySelectorAll('.back').forEach(item => { item.onclick = () => showPage(item.dataset.page); });
  el('composer').onsubmit = event => {
    event.preventDefault(); const prompt = el('prompt').value.trim();
    if (attachmentsReading) return;
    if (!prompt && !attachments.length) return;
    if (isRunning(state.activeSessionId || '')) {
      const menu = el('send-menu'); menu.hidden = !menu.hidden; el('send').setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden) menu.querySelector('.send-option')?.focus();
      return;
    }
    send({ type: 'sendPrompt', prompt, images: attachments }); el('prompt').value = ''; attachments = []; renderAttachments();
  };
  document.querySelectorAll('.send-option').forEach((option, index, options) => {
    option.onclick = () => {
      const prompt = el('prompt').value.trim();
      closeSendMenu();
      if (attachmentsReading || (!prompt && !attachments.length)) return;
      send({ type: 'sendPrompt', prompt, images: attachments, mode: option.dataset.mode });
      el('prompt').value = ''; attachments = []; renderAttachments(); el('prompt').focus();
    };
    option.onkeydown = event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault(); options[(index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length].focus();
    };
  });
  const fileInput = el('image-input');
  if (fileInput) fileInput.accept = '';
  el('attach').onclick = () => fileInput.click();
  fileInput.onchange = event => { const files = [...event.target.files]; event.target.value = ''; addFiles(files); };
  el('prompt').onpaste = event => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) { event.preventDefault(); addFiles(files); }
  };
  const composerInput = el('composer-input');
  const dragTarget = composerInput || el('composer');
  for (const target of [dragTarget].filter(Boolean)) {
    target.addEventListener('dragover', event => { event.preventDefault(); dragTarget?.classList.add('drag-over'); });
    target.addEventListener('dragleave', event => { if (!dragTarget?.contains(event.relatedTarget)) dragTarget?.classList.remove('drag-over'); });
    target.addEventListener('drop', event => {
      event.preventDefault(); dragTarget?.classList.remove('drag-over');
      addFiles([...(event.dataTransfer?.files || [])]);
    });
  }
  el('instructions').onclick = () => showPage(page === 'instructions' ? 'chat' : 'instructions');
  el('add-rule').onclick = () => openInstructionForm('rule');
  el('add-skill').onclick = () => openInstructionForm('skill');
  el('instruction-scope').onchange = updateInstructionForm;
  el('instruction-cancel').onclick = () => { el('instruction-form').hidden = true; };
  el('instruction-form').onsubmit = event => {
    event.preventDefault();
    const form = el('instruction-form'); const content = el('instruction-content');
    if (content.disabled) return;
    const kind = form.dataset.kind; const name = el('instruction-name').value.trim();
    if (!form.dataset.id && kind === 'skill' && !name) { el('instruction-name').focus(); return; }
    send({ type: 'saveInstruction', id: form.dataset.id || undefined, kind, scope: el('instruction-scope').value, file: el('instruction-file').value,
      name, description: el('instruction-description').value.trim(), content: content.value });
  };
  el('approval').onclick = () => { state.approvalMode = { ask: 'auto', auto: 'full', full: 'ask' }[state.approvalMode] || 'ask'; renderApproval(); send({ type: 'setApproval', mode: state.approvalMode }); };
  el('prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); el('composer').requestSubmit(); } };
  el('cancel').onclick = () => send({ type: 'cancel' });
  el('account-cancel').onclick = () => { el('account-form').hidden = true; el('account-key').value = ''; };
  el('account-form').onsubmit = event => {
    event.preventDefault(); const provider = el('account-form').dataset.provider;
    const label = el('account-name').value.trim(); const email = el('account-email').value.trim(); const secret = el('account-key').value.trim();
    if (el('account-form').dataset.oauth === 'true') { if (provider && label) { el('account-submit').disabled = true; el('account-submit').textContent = 'Waiting for browser...'; send({ type: 'addOAuthAccount', provider, label, email }); } }
    else if (provider && label && secret) send({ type: 'addAccount', provider, label, email, secret });
  };
  el('subagents').onclick = () => showPage('subagents');
  el('toolcalls').onclick = () => showPage(page === 'toolcalls' ? 'chat' : 'toolcalls');
  el('add-toolpack').onclick = () => send({ type: 'pickToolpack' });
  el('add-subagent').onclick = () => openSubagentForm();
  el('subagent-cancel').onclick = () => { el('subagent-form').hidden = true; };
  el('subagent-model').onchange = () => updateSubagentOptions();
  el('subagent-form').onsubmit = event => {
    event.preventDefault();
    const profile = { name: el('subagent-name').value.trim(), description: el('subagent-description').value.trim() || undefined, model: el('subagent-model').value,
      effort: el('subagent-effort').value || undefined, speed: el('subagent-speed').value || undefined, mode: el('subagent-mode').value };
    if (profile.name && profile.model) send({ type: 'saveSubagent', originalName: el('subagent-form').dataset.originalName || undefined, profile });
  };
  el('add-model').onclick = () => openModelForm();
  el('model-provider').onchange = () => { const provider = el('model-provider').value; if ((provider === 'codex-cli' || provider === 'claude-cli') && !el('model-backend').value.trim()) el('model-backend').value = 'default'; updateModelSources(); };
  el('model-cancel').onclick = () => { el('model-form').hidden = true; };
  el('model-form').onsubmit = event => {
    event.preventDefault(); const provider = el('model-provider').value;
    const backend = provider === 'cursor-acp' ? el('model-cursor-backend').value : el('model-backend').value.trim();
    const name = el('model-name').value.trim(); const account = el('model-account').value;
    const speedText = el('model-speed-options').value.trim();
    const speedParts = speedText ? speedText.split(',') : [];
    const speedOptions = speedText ? [{ label: 'None', backend }, ...speedParts.map(part => {
      if (provider === 'codex-cli' || provider === 'claude-cli') {
        const label = part.split('=')[0].trim().toLowerCase();
        return { label: ({ standard: 'Standard', fast: 'Fast', ...(provider === 'codex-cli' ? { ultrafast: 'Ultrafast' } : {}) })[label] || '', backend };
      }
      const split = part.indexOf('='); return split < 0 ? { label: '', backend: '' } : { label: part.slice(0, split).trim(), backend: part.slice(split + 1).trim() };
    })] : [];
    if (speedText && speedOptions.some(item => !item.label || !item.backend || item.label.includes('='))) { el('model-speed-options').setCustomValidity(provider === 'codex-cli' ? 'Use Fast or Ultrafast, separated by commas.' : provider === 'claude-cli' ? 'Use Fast.' : 'Use Label=model-id for each speed choice.'); el('model-speed-options').reportValidity(); return; }
    el('model-speed-options').setCustomValidity('');
    const effortOptions = [...new Set(el('model-effort-options').value.split(',').map(item => item.trim().toLowerCase()).filter(Boolean))];
    if (name && provider && backend && account) send({ type: 'saveModel', originalName: el('model-form').dataset.originalName || undefined, name, provider, backend, account, speedOptions, effortOptions });
  };
  el('model-speed-options').oninput = () => el('model-speed-options').setCustomValidity('');

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'sessionState': state.sessions = message.sessions || []; state.activeSessionId = message.activeSessionId; break;
      case 'modelState': {
        const incoming = message.models || [];
        for (const name of [...removingModels]) if (!incoming.some(item => item.name === name)) removingModels.delete(name);
        state.models = incoming.filter(item => !removingModels.has(item.name));
        state.cursorBackends = message.cursorBackends || [];
        if (!removingModels.has(message.selectedModelId)) state.selectedModelId = message.selectedModelId;
        state.selectedSpeed = message.selectedSpeed; state.selectedEffort = message.selectedEffort;
        break;
      }
      case 'sessionDeleted':
        for (const table of [state.timeline, state.messages, state.subagents, state.runStates, state.queues]) delete table?.[message.sessionId];
        break;
      case 'queueState': (state.queues ||= {})[message.sessionId] = message.items || []; renderQueue(); break;
      case 'accountState': state.providerLabel = message.provider; state.accountLabel = message.label; state.accountConnected = message.connected; break;
      case 'accountsState': state.accounts = message.accounts || []; state.cursor = message.cursor || state.cursor; break;
      case 'accountSaved': el('account-form').hidden = true; el('account-key').value = ''; el('account-submit').disabled = false; state.error = undefined; break;
      case 'modelSaved': el('model-form').hidden = true; state.error = undefined; break;
      case 'modelRemoveFailed': removingModels.delete(message.name); break;
      case 'subagentProfilesState': state.subagentProfiles = message.profiles || []; if (page === 'subagents') renderSubagents(); break;
      case 'toolpacksState': state.toolpacks = message.packs || []; state.toolpackError = message.error; if (page === 'toolcalls') renderToolpacks(); break;
      case 'subagentSaved': el('subagent-form').hidden = true; state.error = undefined; break;
      case 'instructionsState': state.instructions = message.items || []; break;
      case 'instructionContent': {
        const form = el('instruction-form');
        if (!form.hidden && form.dataset.id === message.id) { const content = el('instruction-content'); content.value = message.content; content.disabled = false; content.focus(); }
        break;
      }
      case 'instructionSaved': el('instruction-form').hidden = true; state.error = undefined; break;
      case 'showPage': showPage(message.page); break;
      case 'userMessage': (state.messages[message.sessionId] ||= []).push({ role: 'user', text: message.text }); (state.timeline[message.sessionId] ||= []).push({ id: message.entryId || `user:${Date.now()}`, kind: 'message', role: 'user', text: message.text }); break;
      case 'assistantDelta': {
        const items = state.messages[message.sessionId] ||= []; const last = items[items.length - 1]; if (last && last.role === 'assistant') last.text += message.text; else items.push({ role: 'assistant', text: message.text });
        const timeline = state.timeline[message.sessionId] ||= []; const id = message.entryId || `assistant:${timeline.length}`;
        const entry = timeline.find(item => item.id === id); if (entry) entry.text += message.text; else timeline.push({ id, kind: 'message', role: 'assistant', text: message.text });
        break;
      }
      case 'assistantMessage': (state.messages[message.sessionId] ||= []).push({ role: 'assistant', text: message.text }); (state.timeline[message.sessionId] ||= []).push({ id: `assistant:${Date.now()}`, kind: 'message', role: 'assistant', text: message.text }); break;
      case 'runState':
        if (state.runStates[message.sessionId]?.state === 'cancelling' && message.state === 'idle') {
          if (message.sessionId === state.activeSessionId) state.tools = state.tools.map(tool => tool.state === 'running' ? { ...tool, state: 'cancelled' } : tool);
          for (const entry of state.timeline[message.sessionId] || []) if (entry.kind === 'tool' && entry.event.state === 'running') entry.event = { ...entry.event, state: 'cancelled' };
          for (const agent of Object.values(state.subagents[message.sessionId] || {})) if (agent.state === 'running') agent.state = 'cancelled';
        }
        state.runStates[message.sessionId] = { state: message.state, label: message.label };
        if (message.state === 'thinking') state.error = undefined;
        if (message.state !== 'idle' && message.sessionId === state.activeSessionId) editingEntryId = '';
        renderSessions();
        break;
      case 'toolEvent': {
        const previous = state.tools.find(item => item.id === message.event.id);
        const event = { ...previous, ...message.event };
        if (event.title === 'Tool' && previous?.title) event.title = previous.title;
        if (!event.detail && previous?.detail) event.detail = previous.detail;
        state.tools = state.tools.filter(item => item.id !== event.id).concat(event);
        const sessionId = message.sessionId || state.activeSessionId;
        if (sessionId && event.kind !== 'edit' && event.kind !== 'subagent') { const timeline = state.timeline[sessionId] ||= []; const id = message.entryId || `tool:${event.id}`; const entry = timeline.find(item => item.id === id); if (entry) entry.event = event; else timeline.push({ id, kind: 'tool', event }); }
        break;
      }
      case 'subagentEvent': {
        const agents = state.subagents[message.sessionId] ||= {};
        const agent = agents[message.agentId] ||= { id: message.agentId, title: message.title || 'Subagent', state: 'running', messages: [] };
        if (message.title) agent.title = message.title;
        if (message.model) agent.model = message.model;
        if (message.prompt) agent.prompt = message.prompt;
        if (message.files) agent.files = message.files;
        if (message.state) agent.state = message.state;
        if (message.text) {
          const id = message.messageId || `message:${agent.messages.length}`;
          const entry = agent.messages.find(item => item.id === id);
          if (entry) entry.text += message.text;
          else agent.messages.push({ id, role: message.role || 'assistant', text: message.text });
        }
        const timeline = state.timeline[message.sessionId] ||= [];
        if (!timeline.some(item => item.kind === 'subagent' && item.agentId === message.agentId)) timeline.push({ id: `subagent:${message.agentId}`, kind: 'subagent', agentId: message.agentId });
        break;
      }
      case 'approvalRequest':
        (state.timeline[message.sessionId] ||= []).push({ id: `approval:${message.id}`, kind: 'approval', title: message.title, detail: message.detail, status: 'pending' });
        break;
      case 'approvalResolved': {
        const entry = (state.timeline[message.sessionId] || []).find(item => item.id === `approval:${message.id}`);
        if (entry) entry.status = message.allowed ? 'allowed' : 'rejected';
        break;
      }
      case 'questionRequest':
        (state.timeline[message.sessionId] ||= []).push({ id: `question:${message.id}`, kind: 'question', questions: message.questions || [], status: 'pending' });
        break;
      case 'questionResolved': {
        const entry = (state.timeline[message.sessionId] || []).find(item => item.id === `question:${message.id}`);
        if (entry) { entry.status = message.answers === null ? 'skipped' : 'answered'; if (message.answers !== null) entry.answers = message.answers; }
        questionDrafts.delete(message.sessionId + '\0' + message.id);
        break;
      }
      case 'toolState': state.tools = message.tools || []; break;
      case 'diff': state.diffs = state.diffs.filter(item => item.id !== message.diff.id).concat(message.diff); break;
      case 'diffState': state.diffs = message.diffs || []; break;
      case 'timelineState': {
        const sessionId = message.sessionId;
        state.timeline[sessionId] = message.timeline || [];
        state.subagents[sessionId] = message.subagents || {};
        state.tools = [];
        expandedBatches.clear();
        batchCounts.clear();
        if (openedSubagent && !state.subagents[sessionId]?.[openedSubagent]) openedSubagent = '';
        if (message.sessionId === state.activeSessionId) { const feed = el('feed'); feed.textContent = ''; feed.dataset.view = ''; }
        break;
      }
      case 'error': state.error = message.message; el('account-submit').disabled = false; if (el('account-form').dataset.oauth === 'true') el('account-submit').textContent = 'Continue in browser'; break;
    }
    if (['userMessage', 'assistantDelta', 'assistantMessage', 'toolEvent', 'subagentEvent', 'toolState', 'diff', 'diffState', 'runState', 'approvalRequest', 'approvalResolved', 'questionRequest', 'questionResolved', 'timelineState'].includes(message.type)) { renderFeed(); if (message.type === 'runState') renderNotice(); }
    else render();
  });
  showPage(page);
  send({ type: 'ready' });
})();
