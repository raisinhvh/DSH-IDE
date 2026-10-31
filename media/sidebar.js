(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const boot = document.getElementById('boot-state');
  const state = JSON.parse(boot.textContent);
  state.usage ||= {};
  state.timeline ||= {};
  state.subagents ||= {};
  state.toolpacks ||= [];
  state.queues ||= {};
  state.approvalMode ||= 'ask';
  state.runStates ||= {};
  state.subagentProfiles ||= [];
  state.instructions ||= [];
  state.features ||= { activityRail: true, autoName: true, shareRules: true, editorContext: true, reduceMotion: false, updateChecks: true, mirror: true, reviewAgent: false, fileSummaries: false, smartAuto: false };
  state.nameModel ||= {};
  state.reviewModel ||= {};
  state.summaryModel ||= {};
  state.deciderModel ||= {};
  state.smartAutoRanks ||= [];
  state.jobs ||= {};
  state.slashCommands ||= [];
  state.accessibility ||= {};
  state.sync ||= { connected: false, auto: true };
  state.railIcons ||= [];
  boot.remove();
  const local = vscode.getState() || {};
  const pages = ['chat', 'accounts', 'models', 'subagents', 'instructions', 'toolcalls', 'customize', 'accessibility', 'sync'];
  const settingsPages = ['instructions', 'models', 'subagents', 'toolcalls', 'customize', 'accessibility', 'sync'];
  let page = pages.includes(state.page) && state.page !== 'chat' ? state.page
    : pages.includes(local.page) ? local.page : 'chat';
  const closedTabs = new Set(Array.isArray(local.closedTabs) ? local.closedTabs : []);
  // Chats that finished while you were looking elsewhere, by finish time. They stay blue on the rail until opened.
  const unread = new Map(Object.entries(local.unread && typeof local.unread === 'object' ? local.unread : {}));
  let selectedAccountProvider = typeof local.accountProvider === 'string' ? local.accountProvider : '';
  const saveLocal = () => vscode.setState({ page, accountProvider: selectedAccountProvider, closedTabs: [...closedTabs], unread: Object.fromEntries(unread) });
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
  const jobBarExpanded = new Map();
  let slashMenuEl = null;
  let slashMatches = [];
  let slashHighlight = 0;
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
  // Must match SMART_AUTO in src/runtime/smartAuto.ts.
  const smartAutoId = 'Smart Auto';
  const providerNames = { 'codex-cli': 'Codex', 'claude-cli': 'Claude Code', 'cursor-acp': 'Cursor', 'deepseek-official': 'DeepSeek', openrouter: 'OpenRouter', 'opencode-go': 'OpenCode Go' };
  const providerLogos = {"claude-cli":{"color":"#D97757","path":"m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"},"codex-cli":{"color":"#10A37F","path":"M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"},"cursor-acp":{"color":"#8B8B8B","path":"M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"},"deepseek-official":{"color":"#4D6BFE","path":"M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45"},"openrouter":{"color":"#6467F2","path":"M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z"},"opencode-go":{"color":"#E8E8E8","path":"M22 24H2V0h20zM17 4.8H7v14.4h10z"}};
  const providerColors = Object.fromEntries(Object.entries(providerLogos).map(([id, logo]) => [id, logo.color]));
  const accountGroups = [
    { provider: 'codex-cli', title: 'ChatGPT Accounts', icon: 'smart_toy', oauth: true },
    { provider: 'claude-cli', title: 'Claude Accounts', icon: 'neurology', oauth: true },
    { provider: 'cursor-acp', title: 'Cursor Accounts', icon: 'account_circle' },
    { provider: 'deepseek-official', title: 'DeepSeek Accounts', icon: 'water_drop' },
    { provider: 'openrouter', title: 'OpenRouter Accounts', icon: 'hub' },
    { provider: 'opencode-go', title: 'OpenCode Go Accounts', icon: 'terminal' },
  ];

  function closeSettings() { el('settings-menu').hidden = true; el('settings-toggle').setAttribute('aria-expanded', 'false'); }

  function showPage(next) {
    page = next; state.page = next; saveLocal(); send({ type: 'pageChanged', page });
    closeSettings();
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

  // Matches the host's check: Smart Auto needs the feature on, an available decider and at least one available ranked model.
  const smartAutoReady = () => {
    const available = id => state.models.some(item => item.id === id && item.enabled !== false);
    return !!state.features.smartAuto && available(state.deciderModel.model) && state.smartAutoRanks.some(rank => available(rank.model));
  };

  function renderPicker() {
    const menu = el('model-menu'); menu.textContent = '';
    const models = state.models.filter(item => item.enabled !== false);
    const auto = smartAutoReady();
    const autoSelected = auto && state.selectedModelId === smartAutoId;
    const selected = autoSelected ? undefined : models.find(item => item.id === state.selectedModelId) || models[0];
    el('model-picker-label').textContent = autoSelected ? smartAutoId : selected ? selected.name : 'Choose model';
    el('model-picker').title = autoSelected ? 'A decider model picks a ranked model for each message' : selected ? (providerNames[selected.provider] || selected.provider) : 'Choose model';
    const options = auto ? [{ id: smartAutoId, name: smartAutoId, detail: 'Picks per message' }, ...models] : models;
    for (const model of options) {
      const item = button('', 'Use ' + model.name, () => {
        state.selectedModelId = model.id; menu.hidden = true; el('model-picker').setAttribute('aria-expanded', 'false');
        send({ type: 'selectModel', modelId: model.id }); renderPicker();
      }, 'model-option');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(model.id === (autoSelected ? smartAutoId : selected?.id)));
      const name = document.createElement('span'); name.className = 'model-option-name'; name.textContent = model.name;
      const provider = document.createElement('span'); provider.className = 'model-option-provider'; provider.textContent = model.detail || providerNames[model.provider] || model.provider;
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

  const calm = () => document.body.classList.contains('reduce-motion') || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const railStatus = id => {
    if ((state.timeline[id] || []).some(item => (item.kind === 'approval' || item.kind === 'question') && item.status === 'pending')) return 'blocked';
    if (isRunning(id)) return 'running';
    return unread.has(id) ? 'done' : '';
  };
  const railRank = { blocked: 0, done: 1, running: 2 };
  const railSince = new Map();
  const railTabs = new Map();
  let railClock = 0;

  function railDetail(id, status) {
    if (status === 'blocked') {
      const pending = (state.timeline[id] || []).find(item => (item.kind === 'approval' || item.kind === 'question') && item.status === 'pending');
      return pending?.kind === 'question' ? 'Waiting for your answer' : 'Waiting for your approval';
    }
    return status === 'done' ? 'Finished. Open to read' : state.runStates[id]?.label || 'Running';
  }

  function openFromRail(id) {
    if (unread.delete(id)) saveLocal();
    if (page !== 'chat') showPage('chat');
    send({ type: 'selectSession', sessionId: id });
    renderRail();
  }

  // Rail motion uses the Web Animations API so every move can be interrupted from wherever it is on screen.
  const railSpring = 'cubic-bezier(.3, 1.45, .45, 1)';
  let railReady = false;
  const play = (node, frames, options, done) => {
    const animation = node.animate?.(frames, options);
    if (done) { if (animation) animation.onfinish = done; else done(); }
    return animation;
  };

  function setRailVisible(rail, visible) {
    const shown = !rail.hidden && !rail.dataset.hiding;
    if (!visible) hideRailFlyout(true);
    if (visible === shown) return;
    rail.toggleAnimation?.cancel();
    delete rail.dataset.hiding;
    // The rail's width follows text size and click-target settings, so slide by whatever it measures.
    const offset = () => `-${rail.offsetWidth || 38}px`;
    if (visible) {
      rail.hidden = false;
      if (railReady && !calm()) rail.toggleAnimation = play(rail, [{ marginLeft: offset(), opacity: 0 }, { marginLeft: '0px', opacity: 1 }], { duration: 460, easing: railSpring });
    } else if (!railReady || calm()) rail.hidden = true;
    else {
      rail.dataset.hiding = 'true';
      rail.toggleAnimation = play(rail, [{ marginLeft: '0px', opacity: 1 }, { marginLeft: offset(), opacity: 0 }],
        { duration: 260, easing: 'cubic-bezier(.5, 0, .9, .4)', fill: 'forwards' }, () => { rail.hidden = true; delete rail.dataset.hiding; rail.toggleAnimation?.cancel(); });
    }
  }

  /** A tab that is no longer needed is pulled out of the flow at its current spot and flicked off to the left. */
  function leaveRail(rail, tab, box) {
    railTabs.delete(tab.dataset.key);
    if (railFlyout?.dataset.key === tab.dataset.key) hideRailFlyout(true);
    tab.onclick = tab.onpointerenter = tab.onpointerleave = tab.onfocus = tab.onblur = null;
    if (calm() || !box?.height) { tab.remove(); return; }
    const frame = rail.getBoundingClientRect();
    tab.getAnimations?.().forEach(animation => animation.cancel());
    tab.classList.add('leaving');
    Object.assign(tab.style, { position: 'absolute', top: `${box.top - frame.top + rail.scrollTop}px`, left: `${box.left - frame.left}px`, height: `${box.height}px` });
    play(tab, [
      { translate: '0 0', scale: '1', opacity: 1, easing: 'cubic-bezier(.3, 0, .5, 1)' },
      { translate: '4px 0', scale: '1.06', opacity: 1, offset: .2, easing: 'cubic-bezier(.55, 0, .9, .45)' },
      { translate: '-150% 0', scale: '.7', opacity: 0 },
    ], { duration: 320, fill: 'forwards' }, () => tab.remove());
    // Backstop in case the view is hidden and the finish event is delayed.
    setTimeout(() => tab.remove(), 600);
  }

  function pulseRailTab(tab) {
    const tone = window.getComputedStyle?.(tab).getPropertyValue('--rail-tone').trim() || '#3794ff';
    tab.pulseAnimation?.cancel();
    // No closing box-shadow keyframe: the ring fades into whatever the tab already shows, such as the active outline.
    tab.pulseAnimation = play(tab, [
      { scale: '1', boxShadow: `0 0 0 0 color-mix(in srgb, ${tone} 75%, transparent)` },
      { scale: '1.12', boxShadow: `0 0 0 4px color-mix(in srgb, ${tone} 35%, transparent)`, offset: .3 },
      { scale: '.97', offset: .62 },
      { scale: '1' },
    ], { duration: 700, easing: 'cubic-bezier(.25, .8, .35, 1)' });
  }

  const railIcon = session => typeof session.icon === 'string' && session.icon.trim() ? session.icon.trim() : 'chat_bubble';
  // The icon each tab showed last render, so tabs keep their icons as other chats come and go.
  const railShown = new Map();
  /** Gives every chat on the rail its own icon: its chosen icon when free, else the one it already shows, else a free fallback. */
  function assignRailIcons(sessions) {
    const icons = new Map(), used = new Set();
    const claim = (id, name) => { icons.set(id, name); used.add(name); };
    const pass = pick => { for (const session of sessions) { const name = !icons.has(session.id) && pick(session); if (name && !used.has(name)) claim(session.id, name); } };
    pass(session => railShown.get(session.id) === railIcon(session) && railIcon(session));
    pass(railIcon);
    pass(session => railShown.get(session.id));
    for (const session of sessions) {
      if (icons.has(session.id)) continue;
      claim(session.id, state.railIcons.find(name => !used.has(name)) || railIcon(session));
    }
    railShown.clear();
    for (const [id, name] of icons) railShown.set(id, name);
    return icons;
  }
  // Hovering or focusing a tab grows it to the right with the chat name. The rail clips its children,
  // so the grown tab is one fixed overlay laid exactly over the tab instead of the tab itself.
  let railFlyout = null;
  function ensureRailFlyout() {
    if (railFlyout) return railFlyout;
    const fly = document.createElement('button'); fly.type = 'button'; fly.className = 'rail-flyout'; fly.hidden = true; fly.tabIndex = -1; fly.setAttribute('aria-hidden', 'true');
    fly.glyph = icon('chat_bubble'); fly.glyph.className = 'symbol rail-icon';
    fly.label = document.createElement('span'); fly.label.className = 'rail-flyout-name';
    fly.append(fly.glyph, fly.label);
    fly.onclick = () => { const id = fly.dataset.key; hideRailFlyout(true); if (id) openFromRail(id); };
    fly.onpointerleave = event => { if (event.relatedTarget !== railTabs.get(fly.dataset.key)) hideRailFlyout(); };
    document.body.appendChild(fly);
    return railFlyout = fly;
  }

  function syncRailFlyout(tab) {
    const fly = railFlyout;
    for (const name of ['running', 'blocked', 'done', 'active']) fly.classList.toggle(name, tab.classList.contains(name));
    fly.glyph.textContent = tab.dataset.icon || 'chat_bubble';
    fly.label.textContent = state.sessions.find(item => item.id === tab.dataset.key)?.name || '';
  }

  function showRailFlyout(tab, focused) {
    if (tab.classList.contains('leaving') || !tab.isConnected) return;
    const box = tab.getBoundingClientRect();
    if (!box.width) return;
    const fly = ensureRailFlyout();
    const same = !fly.hidden && fly.dataset.key === tab.dataset.key;
    const from = same ? fly.getBoundingClientRect().width : box.width;
    fly.dataset.key = tab.dataset.key; fly.dataset.base = String(box.width);
    syncRailFlyout(tab);
    fly.classList.toggle('focused', !!focused);
    fly.widthAnimation?.cancel(); fly.widthAnimation = undefined;
    Object.assign(fly.style, { left: `${box.left}px`, top: `${box.top}px`, height: `${box.height}px`, minWidth: `${box.width}px`, width: 'max-content' });
    fly.style.setProperty('--rail-base', `${box.width}px`);
    fly.hidden = false;
    const to = Math.max(box.width, Math.min(fly.offsetWidth, window.innerWidth - box.left - 6));
    fly.style.width = `${to}px`;
    // Start from the plain icon so the name cross-fades in rather than appearing already shown.
    if (!same) { fly.classList.remove('open'); void fly.offsetWidth; }
    fly.classList.add('open');
    if (!calm() && Math.abs(to - from) > .5) fly.widthAnimation = play(fly, [{ width: `${from}px` }, { width: `${to}px` }], { duration: 420, easing: railSpring });
  }

  function hideRailFlyout(now) {
    const fly = railFlyout;
    if (!fly || fly.hidden) return;
    fly.classList.remove('open', 'focused');
    fly.widthAnimation?.cancel(); fly.widthAnimation = undefined;
    const base = Number(fly.dataset.base) || 0;
    if (now || calm() || !base) { fly.hidden = true; return; }
    const from = fly.getBoundingClientRect().width;
    fly.style.width = `${base}px`;
    const shrink = play(fly, [{ width: `${from}px` }, { width: `${base}px` }], { duration: 220, easing: 'cubic-bezier(.4, 0, .2, 1)' });
    fly.widthAnimation = shrink;
    const done = () => { if (fly.widthAnimation === shrink) { fly.hidden = true; fly.widthAnimation = undefined; } };
    if (shrink) shrink.onfinish = done; else done();
  }

  /** Reuses tab nodes so color and width changes transition, and animates every arrival, departure, move and state change. */
  function renderRail() {
    const rail = el('rail');
    setRailVisible(rail, !!state.features.activityRail);
    if (!state.features.activityRail) return;
    if (page === 'chat' && unread.delete(state.activeSessionId || '')) saveLocal();
    const items = [];
    for (const session of state.sessions) {
      const status = railStatus(session.id);
      const since = railSince.get(session.id);
      if (!status) { railSince.delete(session.id); continue; }
      // The most recent state change sorts first within its group.
      if (since?.status !== status) railSince.set(session.id, { status, at: ++railClock });
      items.push({ session, status, at: railSince.get(session.id).at });
    }
    items.sort((a, b) => railRank[a.status] - railRank[b.status] || b.at - a.at);
    const icons = assignRailIcons(items.map(item => item.session));
    const motion = !calm();
    // Measure on-screen positions first, including any move still in flight, so new motion starts where the eye is.
    const before = new Map([...railTabs].map(([id, node]) => [id, node.getBoundingClientRect()]));
    const keep = new Set(items.map(item => item.session.id));
    for (const [id, node] of [...railTabs]) if (!keep.has(id)) leaveRail(rail, node, before.get(id));
    for (const node of railTabs.values()) { node.moveAnimation?.cancel(); node.moveAnimation = undefined; node.style.zIndex = ''; }
    let head = rail.querySelector('.rail-head');
    if (!head) {
      head = icon('dynamic_feed'); head.className = 'symbol rail-head'; head.title = 'Running chats, chats waiting on you, and finished chats you have not opened appear here.';
      rail.insertBefore(head, rail.firstChild || null);
    }
    const applyTab = (tab, session, status) => {
      const detail = railDetail(session.id, status);
      tab.dataset.status = status;
      tab.className = ['rail-tab', status, session.id === state.activeSessionId ? 'active' : ''].filter(Boolean).join(' ');
      tab.title = session.name + ': ' + detail;
      tab.setAttribute('aria-label', session.name + '. ' + detail);
      tab.dataset.icon = tab.firstChild.textContent = icons.get(session.id);
    };
    rail.onscroll = () => hideRailFlyout(true);
    // Put tabs in order, moving only the ones out of place: a moved node loses its running CSS transitions.
    const changes = [];
    let cursor = head.nextSibling;
    for (const { session, status } of items) {
      let tab = railTabs.get(session.id);
      const fresh = !tab;
      if (fresh) {
        tab = document.createElement('button'); tab.type = 'button'; tab.dataset.key = session.id;
        const glyph = icon('chat_bubble'); glyph.className = 'symbol rail-icon'; glyph.setAttribute('aria-hidden', 'true');
        tab.append(glyph);
        tab.onclick = () => openFromRail(session.id);
        tab.onpointerenter = () => showRailFlyout(tab);
        tab.onpointerleave = event => { if (!railFlyout || event.relatedTarget !== railFlyout) hideRailFlyout(); };
        tab.onfocus = () => showRailFlyout(tab, true);
        tab.onblur = () => { if (!railFlyout?.matches(':hover')) hideRailFlyout(); };
        railTabs.set(session.id, tab);
        applyTab(tab, session, status);
      }
      while (cursor?.classList?.contains('leaving')) cursor = cursor.nextSibling;
      if (cursor === tab) cursor = tab.nextSibling;
      else rail.insertBefore(tab, cursor || null);
      changes.push({ id: session.id, tab, fresh, session, status });
    }
    // Flush styles so moved tabs keep their old look for a frame; the class change below then transitions instead of snapping.
    void rail.offsetHeight;
    for (const change of changes) {
      if (change.fresh) continue;
      change.changed = change.tab.dataset.status !== change.status;
      change.reiconed = change.tab.dataset.icon !== icons.get(change.id);
      applyTab(change.tab, change.session, change.status);
    }
    // An open flyout follows its tab's look; if the tab was moved out from under the pointer, the flyout goes.
    const flown = railFlyout && !railFlyout.hidden ? railTabs.get(railFlyout.dataset.key) : undefined;
    if (flown) {
      const old = before.get(flown.dataset.key);
      if (old?.height && Math.abs(old.top - flown.getBoundingClientRect().top) > .5) hideRailFlyout(true);
      else syncRailFlyout(flown);
    }
    if (!motion) { railReady = true; return; }
    let arrivals = 0;
    for (const { id, tab, fresh, changed, reiconed } of changes) {
      if (fresh) {
        // Springs in from the rail edge with a little overshoot; tabs present on first load arrive one after another.
        play(tab, [
          { translate: '-150% 0', scale: '.55', opacity: 0, easing: 'cubic-bezier(.2, .9, .35, 1)' },
          { translate: '5px 0', scale: '1.08', opacity: 1, offset: .55, easing: 'cubic-bezier(.4, 0, .5, 1)' },
          { translate: '-1px 0', scale: '.97', offset: .8, easing: 'ease-in-out' },
          { translate: '0 0', scale: '1' },
        ], { duration: 640, delay: railReady ? 0 : arrivals++ * 55, fill: 'backwards' });
        continue;
      }
      const old = before.get(id);
      const now = tab.getBoundingClientRect();
      // A zero-size rect means the chat page was hidden; sliding from there would sweep in from the top.
      const shift = old?.height ? old.top - now.top : 0;
      if (Math.abs(shift) > .5) {
        // Tabs rising toward the top pass over the ones making room for them.
        tab.style.zIndex = shift > 0 ? '2' : '';
        const move = play(tab, [{ translate: `0 ${shift}px` }, { translate: '0 0' }], { duration: 560, easing: railSpring, composite: 'add' });
        tab.moveAnimation = move;
        if (move) move.onfinish = () => { if (tab.moveAnimation === move) tab.style.zIndex = ''; };
      }
      if (reiconed) play(tab.firstChild, [{ opacity: 0, filter: 'blur(3px)', scale: '.6' }, { opacity: 1, filter: 'blur(0px)', scale: '1' }], { duration: 360, easing: railSpring });
      if (changed) pulseRailTab(tab);
    }
    railReady = true;
  }

  function renderSessions() {
    const root = el('sessions');
    const menu = el('recent-menu'); menu.textContent = '';
    renderRail();
    if (!state.sessions.length) { rebuild(root, () => { const empty = document.createElement('div'); empty.className = 'session-empty'; empty.textContent = 'New chat'; root.appendChild(empty); }); return; }
    if (state.features.activityRail) {
      // The rail tracks active work, so the top shows only the open chat's name.
      const active = state.sessions.find(item => item.id === state.activeSessionId);
      rebuild(root, () => {
        const title = keyed(document.createElement('div'), 'title:' + (active?.id || '')); title.className = 'session-title';
        title.textContent = active?.name || 'New chat'; title.title = title.textContent;
        if (active && isRunning(active.id)) title.prepend(runDot());
        root.appendChild(title);
      });
    } else renderTabs(root);
    for (const session of state.sessions) {
      const row = document.createElement('div'); row.className = 'recent-row';
      const open = button(session.name, 'Open ' + session.name, () => { closedTabs.delete(session.id); unread.delete(session.id); saveLocal(); send({ type: 'selectSession', sessionId: session.id }); menu.hidden = true; el('recent-toggle').setAttribute('aria-expanded', 'false'); }, 'recent-item');
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
    menu.appendChild(deleteAllRow());
  }

  // Armed state lives outside the menu because the menu is rebuilt whenever any chat changes.
  let deleteAllArmed = 0;
  function deleteAllRow() {
    const deletable = state.sessions.filter(session => !isRunning(session.id)).length;
    const running = state.sessions.length - deletable;
    const footer = document.createElement('div'); footer.className = 'recent-footer';
    const title = deletable ? `Delete ${deletable} chat${deletable === 1 ? '' : 's'} and their unapplied changes${running ? `; ${running} running chat${running === 1 ? ' is' : 's are'} kept` : ''}` : 'Only running chats are left; cancel them to delete';
    const glyph = icon('delete_sweep'); const text = document.createTextNode('');
    const action = button('', title, () => {
      if (deleteAllArmed > Date.now()) {
        deleteAllArmed = 0;
        el('recent-menu').hidden = true; el('recent-toggle').setAttribute('aria-expanded', 'false');
        send({ type: 'deleteAllSessions' });
        return;
      }
      // Updated in place: replacing the clicked node would make the outside-click handler close the menu.
      deleteAllArmed = Date.now() + 3000;
      show();
      setTimeout(() => { if (deleteAllArmed && deleteAllArmed <= Date.now()) deleteAllArmed = 0; if (action.isConnected) show(); }, 3050);
    }, 'recent-delete-all');
    const show = () => {
      const armed = deleteAllArmed > Date.now() && deletable > 0;
      action.classList.toggle('confirming', armed);
      glyph.textContent = armed ? 'delete_forever' : 'delete_sweep';
      text.textContent = armed ? `Click again to delete ${deletable} chat${deletable === 1 ? '' : 's'}` : 'Delete all';
    };
    action.append(glyph, text);
    action.disabled = !deletable;
    show();
    footer.appendChild(action);
    return footer;
  }

  function renderTabs(root) {
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

  const jobPhaseLabel = { draft: 'Drafting', work: 'Working', verify: 'Reviewing', done: 'Done', stopped: 'Stopped' };
  const criterionIcon = { pending: 'radio_button_unchecked', pass: 'check_circle', fail: 'cancel' };
  const sourceChipLabel = source => /^answer:(\d+)$/.test(source) ? 'answer #' + source.slice(7) : source;

  function renderJobBar(feed, sessionId, job) {
    const key = 'job-bar:' + sessionId;
    let node = feed.querySelector('[data-key="' + key + '"]');
    const expanded = jobBarExpanded.get(sessionId) || false;
    const passCount = job.criteria.filter(item => item.status === 'pass').length;
    const criteriaTotal = job.criteria.length;
    const roundLabel = job.round === 0 ? 'Job · drafting' : 'Job · round ' + job.round;
    const signature = JSON.stringify([job.phase, job.round, job.stopReason, expanded, job.criteria]);
    if (node && node.dataset.signature === signature) return;
    if (!node) { node = keyed(document.createElement('div'), key); node.className = 'job-bar'; feed.prepend(node); }
    node.textContent = '';
    const head = button('', expanded ? 'Collapse job details' : 'Expand job details', () => { jobBarExpanded.set(sessionId, !expanded); renderFeed(); }, 'job-bar-head');
    head.setAttribute('aria-expanded', String(expanded));
    head.append(icon('checklist'));
    const title = document.createElement('span'); title.className = 'job-bar-title'; title.textContent = roundLabel;
    const phase = document.createElement('span'); phase.className = 'job-bar-phase'; phase.textContent = jobPhaseLabel[job.phase] || job.phase;
    head.append(title, phase);
    if (criteriaTotal) {
      const counts = document.createElement('span'); counts.className = 'job-bar-counts'; counts.textContent = passCount + '/' + criteriaTotal + ' passing';
      head.appendChild(counts);
    }
    const chevron = icon(expanded ? 'expand_less' : 'expand_more'); chevron.classList.add('small'); head.appendChild(chevron);
    node.appendChild(head);
    if (expanded) {
      const body = document.createElement('div'); body.className = 'job-bar-body';
      if (job.stopReason) {
        const reason = document.createElement('div'); reason.className = 'job-bar-stop job-bar-stop-' + job.phase;
        reason.textContent = job.stopReason; body.appendChild(reason);
      }
      const list = document.createElement('div'); list.className = 'job-criteria';
      for (const criterion of job.criteria) {
        const row = document.createElement('div'); row.className = 'job-criterion job-criterion-' + criterion.status;
        if (criterion.status === 'pass' && criterion.evidence) row.title = criterion.evidence;
        const glyph = icon(criterionIcon[criterion.status] || criterionIcon.pending); glyph.classList.add('small', 'job-criterion-icon');
        const main = document.createElement('div'); main.className = 'job-criterion-main';
        const line = document.createElement('div'); line.className = 'job-criterion-line';
        const id = document.createElement('span'); id.className = 'job-criterion-id'; id.textContent = criterion.id;
        const text = document.createElement('span'); text.className = 'job-criterion-text'; text.textContent = criterion.text;
        const chip = document.createElement('span'); chip.className = 'job-criterion-source'; chip.textContent = sourceChipLabel(criterion.source);
        line.append(id, text, chip);
        if (criterion.check) { const code = document.createElement('code'); code.className = 'job-criterion-check'; code.textContent = criterion.check; line.appendChild(code); }
        main.appendChild(line);
        if (criterion.status === 'fail' && criterion.evidence) {
          const evidence = document.createElement('div'); evidence.className = 'job-criterion-evidence'; evidence.textContent = criterion.evidence;
          main.appendChild(evidence);
        }
        row.append(glyph, main); list.appendChild(row);
      }
      body.appendChild(list); node.appendChild(body);
    }
    node.dataset.signature = signature;
  }

  // Media the agent sends is served from state.mediaBase; anything that will not play inline opens through the host.
  const mediaUrl = file => state.mediaBase + '/' + String(file).split('/').map(encodeURIComponent).join('/');
  function mediaChip(item) {
    const chip = button('', 'Open ' + item.name, () => send({ type: 'openMedia', file: item.file }), 'media-file');
    const name = document.createElement('span'); name.className = 'media-file-name'; name.textContent = item.name;
    chip.append(icon('description'), name); return chip;
  }
  function mediaItem(item) {
    const kind = state.mediaBase && item.file ? /^(image|video|audio)\//.exec(item.mimeType || '')?.[1] : undefined;
    if (!kind) return mediaChip(item);
    const figure = document.createElement('figure'); figure.className = 'media-item media-' + kind;
    const player = document.createElement(kind === 'image' ? 'img' : kind);
    if (kind === 'image') {
      player.loading = 'lazy'; player.alt = item.name;
      const open = button('', 'Open ' + item.name, () => send({ type: 'openMedia', file: item.file }), 'media-open');
      open.appendChild(player); figure.appendChild(open);
    } else {
      player.controls = true; if (kind === 'video') player.preload = 'metadata';
      figure.appendChild(player);
    }
    player.onerror = () => figure.replaceWith(mediaChip(item));
    player.src = mediaUrl(item.file);
    if (kind !== 'audio') { const caption = document.createElement('figcaption'); caption.className = 'media-name'; caption.textContent = item.name; caption.title = item.name; figure.appendChild(caption); }
    return figure;
  }

  // Keyframes sampled from a damped spring, so motion can ring past its target, which a cubic-bezier cannot do.
  // frame(p) builds the keyframe for progress p, which starts at 0 and settles at 1. damping is the ratio, below 1.
  function springAnimation(frame, frequency, damping) {
    const omega = 2 * Math.PI * frequency;
    const decay = damping * omega;
    const ringing = omega * Math.sqrt(1 - damping * damping);
    const seconds = Math.min(1.6, Math.log(400) / decay);
    const steps = Math.ceil(seconds * 60);
    const frames = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps * seconds;
      const p = i === steps ? 1 : 1 - Math.exp(-decay * t) * (Math.cos(ringing * t) + decay / ringing * Math.sin(ringing * t));
      frames.push({ ...frame(p), offset: i / steps });
    }
    return { frames, duration: seconds * 1000 };
  }

  // Generated images start small and pop in on a loosely damped spring.
  const freshMedia = new Set();
  function popIn(node) {
    if (calm()) return;
    const from = .3;
    const { frames, duration } = springAnimation(p => ({ transform: `scale(${from + (1 - from) * p})` }), 2.6, .32);
    node.popAnimation?.cancel();
    node.popAnimation = play(node, frames, { duration });
    play(node, [{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' });
  }

  function imageThumb(item, reveal) {
    if (!state.mediaBase || !item.file || !isImageMime(item.mimeType || '')) return mediaItem(item);
    const thumb = button('', 'Expand ' + item.name, () => openLightbox(item, thumb), 'image-thumb');
    const image = document.createElement('img'); image.alt = item.name; image.draggable = false;
    image.onerror = () => thumb.replaceWith(mediaChip(item));
    if (reveal && !calm()) image.onload = () => play(image, [{ opacity: 0, transform: 'scale(.9)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: railSpring });
    image.src = mediaUrl(item.file);
    thumb.appendChild(image);
    return thumb;
  }

  // The box a generated image will fill: a loading circle while it is made, or an error mark if it failed.
  function statusThumb(status) {
    const box = document.createElement('div'); box.className = 'image-thumb image-thumb-' + status;
    box.setAttribute('role', 'status');
    const label = status === 'pending' ? 'Generating image' : 'Image generation failed';
    box.setAttribute('aria-label', label); box.title = label;
    const mark = icon(status === 'pending' ? 'progress_activity' : 'broken_image');
    if (status === 'pending') mark.classList.add('spinning');
    box.appendChild(mark);
    return box;
  }

  // Full view of a generated image inside the sidebar. It grows out of its thumbnail and shrinks back into it.
  let lightbox;
  function openLightbox(item, source) {
    closeLightbox(true);
    const root = document.createElement('div'); root.className = 'lightbox';
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', item.name);
    const bar = document.createElement('div'); bar.className = 'lightbox-bar';
    const name = document.createElement('span'); name.className = 'lightbox-name'; name.textContent = item.name; name.title = item.name;
    const open = button('', 'Open in editor', () => send({ type: 'openMedia', file: item.file }), 'icon-button', 'open_in_new');
    const close = button('', 'Close', () => closeLightbox(), 'icon-button', 'close');
    bar.append(name, open, close);
    const stage = document.createElement('div'); stage.className = 'lightbox-stage';
    const image = document.createElement('img'); image.className = 'lightbox-image'; image.alt = item.name; image.draggable = false;
    stage.appendChild(image); root.append(bar, stage);
    root.onclick = event => { if (event.target === root || event.target === stage) closeLightbox(); };
    root.onkeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); closeLightbox(); }
      else if (event.key === 'Tab') { event.preventDefault(); (document.activeElement === open ? close : open).focus(); }
    };
    lightbox = { root, image, source };
    const motion = !calm();
    // Hidden until it can grow from the thumbnail, so it never flashes at full size first.
    if (motion) image.style.visibility = 'hidden';
    image.src = mediaUrl(item.file);
    document.body.appendChild(root);
    close.focus({ preventScroll: true });
    if (!motion) return;
    play(root, [{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
    const grow = () => {
      image.style.visibility = '';
      if (lightbox?.root !== root) return;
      const to = image.getBoundingClientRect(), from = source.isConnected ? source.getBoundingClientRect() : undefined;
      if (!from?.width || !to.width) return;
      const dx = from.left + from.width / 2 - (to.left + to.width / 2), dy = from.top + from.height / 2 - (to.top + to.height / 2);
      const scale = Math.min(from.width / to.width, from.height / to.height);
      const { frames, duration } = springAnimation(p => ({ transform: `translate(${dx * (1 - p)}px, ${dy * (1 - p)}px) scale(${scale + (1 - scale) * p})` }), 3.2, .55);
      image.growAnimation = play(image, frames, { duration });
    };
    if (image.complete && image.naturalWidth) grow(); else if (image.decode) image.decode().then(grow, grow); else image.onload = image.onerror = grow;
  }

  function closeLightbox(now) {
    if (!lightbox) return;
    const { root, image, source } = lightbox;
    lightbox = undefined;
    root.classList.add('closing');
    if (source.isConnected) source.focus({ preventScroll: true });
    if (now || calm()) { root.remove(); return; }
    // Shrink from wherever the image is now, even mid-grow.
    const current = getComputedStyle(image).transform;
    image.growAnimation?.cancel();
    const box = image.getBoundingClientRect(), target = source.isConnected ? source.getBoundingClientRect() : undefined;
    const end = target?.width && box.width
      ? `translate(${target.left + target.width / 2 - (box.left + box.width / 2)}px, ${target.top + target.height / 2 - (box.top + box.height / 2)}px) scale(${Math.min(target.width / box.width, target.height / box.height)})`
      : 'scale(.92)';
    play(image, [{ transform: current }, { transform: end }], { duration: 200, easing: 'cubic-bezier(.4, 0, .8, .6)', fill: 'forwards' });
    play(root, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease-in', fill: 'forwards' }, () => root.remove());
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
    renderAgents();
    el('cancel').hidden = !running;
    el('cancel').disabled = run.state === 'cancelling';
    fitComposerActions();
    const status = el('status'); status.hidden = !running; status.textContent = running ? run.label || '' : '';
    const selectedAgent = state.subagents?.[sessionId]?.[openedSubagent];
    if (selectedAgent) { renderSubagentFeed(feed, selectedAgent); return; }
    if (openedSubagent) openedSubagent = '';
    if (feed.dataset.view !== sessionId) { feed.textContent = ''; feed.dataset.view = sessionId; }
    const job = state.jobs?.[sessionId];
    if (job) renderJobBar(feed, sessionId, job);
    else feed.querySelector('[data-key="job-bar:' + sessionId + '"]')?.remove();
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
            // Single-choice drafts are { option } or { other }; multi-select drafts are { picked, other? }.
            const otherText = draft => typeof draft.other === 'string' ? draft.other.trim() : '';
            const ready = () => entry.questions.every((question, i) => {
              const draft = drafts[i];
              if (!draft) return false;
              return question.multiSelect ? !!(draft.picked?.length || otherText(draft)) : draft.option !== undefined || !!otherText(draft);
            });
            const submit = () => {
              if (!ready()) return;
              const answers = entry.questions.map((question, i) => {
                const draft = drafts[i];
                if (question.multiSelect) return [...[...(draft.picked || [])].sort((a, b) => a - b).map(index => question.options[index]?.label), otherText(draft)].filter(Boolean).join(', ');
                return draft.option !== undefined ? question.options[draft.option]?.label || '' : otherText(draft);
              });
              send({ type: 'questionResponse', id: qid, answers });
            };
            entry.questions.forEach((question, questionIndex) => {
              const multi = question.multiSelect === true;
              const block = document.createElement('section'); block.className = 'question-block' + (multi ? ' question-multi' : '');
              if (question.header) { const chip = document.createElement('div'); chip.className = 'question-header'; chip.textContent = question.header; block.appendChild(chip); }
              const prompt = document.createElement('div'); prompt.className = 'question-prompt'; prompt.textContent = question.question; block.appendChild(prompt);
              if (multi) { const hint = document.createElement('div'); hint.className = 'question-option-description'; hint.textContent = 'Select all that apply'; block.appendChild(hint); }
              const group = document.createElement('div'); group.className = 'question-options'; group.setAttribute('role', multi ? 'group' : 'radiogroup'); group.setAttribute('aria-label', question.question);
              const draft = drafts[questionIndex] || {};
              const choices = [...(question.options || []), { label: 'Other…' }];
              const otherIndex = choices.length - 1;
              const radios = [];
              const expand = document.createElement('div'); expand.className = 'question-other-expand';
              const clip = document.createElement('div'); clip.className = 'question-other-clip';
              const input = document.createElement('input'); input.className = 'question-other-input'; input.type = 'text'; input.setAttribute('aria-label', 'Your answer'); input.placeholder = 'Type your answer';
              // Selection updates the existing nodes so animations and keyboard focus survive.
              const isSelected = (current, i) => i === otherIndex ? current.other !== undefined : multi ? (current.picked || []).includes(i) : current.option === i;
              // Multi-select toggles each option, including Other…; single choice replaces the selection.
              const select = (index, focusInput) => {
                const isOther = index === otherIndex;
                const current = drafts[questionIndex] || {};
                if (multi) {
                  const picked = new Set(current.picked || []);
                  let other = current.other;
                  if (isOther) other = other === undefined ? '' : undefined;
                  else if (picked.has(index)) picked.delete(index); else picked.add(index);
                  drafts[questionIndex] = { picked: [...picked], other };
                } else drafts[questionIndex] = isOther ? { other: current.other || '' } : { option: index };
                questionDrafts.set(draftKey, drafts);
                const next = drafts[questionIndex];
                radios.forEach((radio, i) => { radio.classList.toggle('question-selected', isSelected(next, i)); radio.setAttribute('aria-checked', String(isSelected(next, i))); });
                const otherOpen = next.other !== undefined;
                expand.classList.toggle('open', otherOpen); input.disabled = !otherOpen;
                if (isOther && otherOpen && focusInput) input.focus();
                updateSubmit();
              };
              choices.forEach((option, optionIndex) => {
                const selected = isSelected(draft, optionIndex);
                const choice = document.createElement('button'); choice.type = 'button'; choice.className = 'question-option' + (selected ? ' question-selected' : ''); choice.setAttribute('role', multi ? 'checkbox' : 'radio'); choice.setAttribute('aria-checked', selected ? 'true' : 'false'); choice.style.setProperty('--i', String(questionIndex * 6 + optionIndex));
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
                  radios[target].focus();
                  if (!multi) select(target, false);
                };
                radios.push(choice); group.appendChild(choice);
              });
              input.value = draft.other || ''; input.disabled = draft.other === undefined; expand.classList.toggle('open', draft.other !== undefined);
              input.oninput = () => { drafts[questionIndex] = multi ? { picked: drafts[questionIndex]?.picked || [], other: input.value } : { other: input.value }; questionDrafts.set(draftKey, drafts); updateSubmit(); };
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
      } else if (entry.kind === 'media') {
        const signature = JSON.stringify([entry.caption || '', entry.items || [], !!entry.generated, entry.status || '']);
        if (node.dataset.text !== signature) {
          // An image that finishes while its box is on screen fades into that box instead of popping in again.
          const reveal = node.dataset.status === 'pending' && !entry.status;
          node.className = 'feed-entry bubble assistant markdown media-entry' + (entry.generated ? ' media-generated' : ''); node.textContent = '';
          if (entry.caption) { const content = document.createElement('div'); content.className = 'message-content'; renderMarkdown(content, entry.caption); node.appendChild(content); }
          if (entry.status) node.appendChild(statusThumb(entry.status));
          else for (const item of entry.items || []) node.appendChild(entry.generated ? imageThumb(item, reveal) : mediaItem(item));
          node.dataset.text = signature;
          node.dataset.status = entry.status || '';
        }
        // Only images that arrive while the chat is open pop in; replayed history just appears.
        if (freshMedia.delete(entry.id)) { node.classList.add('media-pop'); node.querySelectorAll('.image-thumb').forEach(popIn); }
      } else if (entry.kind === 'note') {
        const signature = [entry.icon || '', entry.text].join('\0');
        if (node.dataset.text !== signature) {
          node.className = 'feed-entry feed-note'; node.textContent = '';
          if (entry.icon) node.appendChild(icon(entry.icon));
          const text = document.createElement('span'); text.textContent = entry.text; node.appendChild(text);
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

  function providerLogo(provider) {
    const logo = providerLogos[provider];
    if (!logo) return icon(accountGroups.find(group => group.provider === provider)?.icon || 'account_circle');
    const wrap = document.createElement('span'); wrap.className = 'provider-logo'; wrap.style.color = logo.color;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', logo.path); path.setAttribute('fill', 'currentColor'); svg.appendChild(path); wrap.appendChild(svg); return wrap;
  }
  const providerColor = provider => providerColors[provider] || 'var(--vscode-charts-purple)';
  const percent = value => Math.max(0, Math.min(100, value));
  function resetIn(at) {
    const mins = Math.ceil((at - Date.now()) / 60000); if (!at || mins <= 0) return '';
    return mins < 60 ? mins + 'm' : mins < 1440 ? Math.floor(mins / 60) + 'h ' + mins % 60 + 'm' : Math.floor(mins / 1440) + 'd ' + Math.floor(mins % 1440 / 60) + 'h';
  }
  function usageFill(value, provider, previous) {
    const fill = document.createElement('div'); fill.className = 'usage-fill' + (value >= 90 ? ' usage-high' : ''); fill.style.backgroundColor = providerColor(provider); fill.style.width = percent(value) + '%'; fill.dataset.percent = String(percent(value));
    if (previous !== undefined && Number(previous) !== percent(value) && !calm()) play(fill, [{ width: previous + '%' }, { width: percent(value) + '%' }], { duration: 460, easing: railSpring });
    return fill;
  }
  function accountRow(account, previous) {
    const row = keyed(document.createElement('div'), 'account:' + account.id); row.className = 'account-card';
    const head = document.createElement('div'); head.className = 'account-card-head';
    const main = document.createElement('div'); main.className = 'row-main';
    const title = document.createElement('div'); title.className = 'row-title'; title.append(document.createTextNode(account.label));
    if (account.isDefault) { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = 'Default'; title.appendChild(badge); }
    main.appendChild(title);
    if (account.email) { const email = document.createElement('div'); email.className = 'row-subtitle'; email.textContent = account.email; main.appendChild(email); }
    const subtitle = document.createElement('div'); subtitle.className = 'row-subtitle'; subtitle.textContent = account.authType === 'oauth' ? 'Browser sign-in' : 'API key'; main.appendChild(subtitle); head.appendChild(main);
    const actions = document.createElement('div'); actions.className = 'row-actions';
    if (!account.isDefault) actions.appendChild(button('', 'Make default', () => send({ type: 'setDefaultAccount', provider: account.provider, accountId: account.id }), 'icon-button', 'star'));
    actions.appendChild(button('', pendingAccountRemoval === account.id ? 'Confirm removal' : 'Remove account', () => {
      if (pendingAccountRemoval === account.id) { pendingAccountRemoval = ''; send({ type: 'removeAccount', accountId: account.id }); }
      else { pendingAccountRemoval = account.id; renderAccounts(); }
    }, 'icon-button', pendingAccountRemoval === account.id ? 'delete_forever' : 'delete')); head.appendChild(actions); row.appendChild(head);
    const usage = state.usage[account.id]; const block = document.createElement('div'); block.className = 'usage-block';
    if (!usage) { const note = document.createElement('div'); note.className = 'usage-note'; note.textContent = 'Loading usage…'; block.appendChild(note); }
    else {
      const metrics = document.createElement('div'); if (usage.loading) metrics.className = 'usage-loading';
      (usage.metrics || []).forEach((metric, index) => {
        const line = document.createElement('div'); line.className = 'usage-row'; const label = document.createElement('span'); label.textContent = metric.label; const value = document.createElement('span');
        const numeric = typeof metric.usedPercent === 'number' && Number.isFinite(metric.usedPercent); const reset = numeric ? resetIn(metric.resetsAt) : '';
        value.textContent = numeric ? Math.round(metric.usedPercent) + '%' + (reset ? ' · resets in ' + reset : '') : metric.value; line.append(label, value); metrics.appendChild(line);
        if (numeric) { const track = document.createElement('div'); track.className = 'usage-track'; const key = account.id + ':' + index + ':' + metric.label; const fill = usageFill(metric.usedPercent, account.provider, previous.get(key)); fill.dataset.usageKey = key; track.appendChild(fill); metrics.appendChild(track); }
      }); block.appendChild(metrics);
      if (!(usage.metrics || []).length && (usage.status === 'unavailable' || usage.status === 'error')) { const note = document.createElement('div'); note.className = 'usage-note' + (usage.status === 'error' ? ' usage-error' : ''); note.textContent = usage.detail || (usage.status === 'error' ? 'Usage unavailable' : 'Usage not available'); block.appendChild(note); }
      if (usage.fetchedAt) { const note = document.createElement('div'); note.className = 'usage-note'; const mins = Math.max(0, Math.floor((Date.now() - usage.fetchedAt) / 60000)); note.textContent = 'Updated ' + (mins < 1 ? 'just now' : mins + 'm ago'); block.appendChild(note); }
    }
    row.appendChild(block); return row;
  }
  function renderAccounts() {
    const root = el('account-groups'); const previous = new Map([...root.querySelectorAll('[data-usage-key]')].map(node => [node.dataset.usageKey, node.dataset.percent]));
    const legacy = state.accounts.filter(account => account.provider === 'openai' || account.provider === 'anthropic');
    const groups = legacy.length ? [...accountGroups, { provider: 'legacy', title: 'Previous API accounts', icon: 'history' }] : accountGroups;
    const accountsFor = group => group.provider === 'legacy' ? legacy : state.accounts.filter(account => account.provider === group.provider);
    if (!groups.some(group => group.provider === selectedAccountProvider)) selectedAccountProvider = groups.find(group => accountsFor(group).length || (group.provider === 'cursor-acp' && state.cursor.connected))?.provider || groups[0].provider;
    rebuild(root, () => {
      const tabs = document.createElement('div'); tabs.className = 'account-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Account providers');
      groups.forEach((group, index) => {
        const count = accountsFor(group).length || (group.provider === 'cursor-acp' && state.cursor.connected ? 1 : 0); const selected = group.provider === selectedAccountProvider;
        const tab = button('', providerNames[group.provider] || 'Previous', () => { selectedAccountProvider = group.provider; saveLocal(); renderAccounts(); }, 'account-tab' + (selected ? ' selected' : ''));
        tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; tab.style.setProperty('--provider-color', providerColor(group.provider)); tab.append(providerLogo(group.provider), document.createTextNode(providerNames[group.provider] || 'Previous'));
        if (count) { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = String(count); tab.appendChild(badge); }
        tab.onkeydown = event => { if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return; event.preventDefault(); selectedAccountProvider = groups[(index + (event.key === 'ArrowRight' ? 1 : groups.length - 1)) % groups.length].provider; saveLocal(); renderAccounts(); root.querySelector('[role="tab"][aria-selected="true"]').focus(); }; tabs.appendChild(tab);
      }); root.appendChild(tabs);
      const group = groups.find(item => item.provider === selectedAccountProvider); const accounts = accountsFor(group);
      const section = keyed(document.createElement('section'), 'group:' + group.provider); section.className = 'provider-group'; section.setAttribute('role', 'tabpanel');
      const heading = document.createElement('div'); heading.className = 'group-heading'; heading.appendChild(providerLogo(group.provider)); const title = document.createElement('h2'); title.textContent = group.title; heading.appendChild(title);
      const refresh = button('', 'Refresh usage', () => send({ type: 'refreshUsage' }), 'icon-button', 'refresh'); if (accounts.some(account => state.usage[account.id]?.loading)) refresh.firstChild.classList.add('spinning'); heading.appendChild(refresh);
      if (group.provider !== 'legacy') heading.appendChild(button('', 'View ' + providerNames[group.provider] + ' usage in your browser', () => send({ type: 'viewProviderUsage', provider: group.provider }), 'icon-button', 'open_in_new')); section.appendChild(heading);
      if (group.provider === 'cursor-acp') {
        const card = document.createElement('div'); card.className = 'account-card'; const line = document.createElement('div'); line.className = 'row-title'; line.textContent = state.cursor.connected ? state.cursor.label || 'Cursor account' : state.cursor.busy ? 'Complete sign-in in your browser…' : 'No Cursor account connected'; card.appendChild(line);
        if (state.cursor.connected) { const sub = document.createElement('div'); sub.className = 'row-subtitle'; sub.textContent = 'Browser sign-in'; card.appendChild(sub); } section.appendChild(card);
        for (const account of accounts) section.appendChild(accountRow(account, previous));
        const footer = document.createElement('div'); footer.className = 'group-footer'; const action = button(state.cursor.connected ? 'Disconnect' : state.cursor.busy ? 'Connecting…' : 'Connect Cursor', state.cursor.connected ? 'Disconnect Cursor' : 'Sign in with Cursor', () => send({ type: state.cursor.connected ? 'cursorLogout' : 'cursorLogin' }), 'secondary-button'); action.disabled = !!state.cursor.busy; footer.appendChild(action); footer.appendChild(button('Refresh', 'Refresh Cursor account status', () => send({ type: 'refreshAccounts' }), 'text-button')); if (state.cursor.authUrl) footer.appendChild(button('Open sign-in page', 'Open Cursor sign-in page', () => send({ type: 'openAuthUrl', url: state.cursor.authUrl }), 'text-button')); section.appendChild(footer);
      } else {
        if (accounts.length) for (const account of accounts) section.appendChild(accountRow(account, previous)); else { const empty = document.createElement('div'); empty.className = 'empty-row'; empty.textContent = 'No accounts added'; section.appendChild(empty); }
        if (group.provider !== 'legacy') { const footer = document.createElement('div'); footer.className = 'group-footer'; footer.appendChild(button(group.oauth ? 'Connect account' : 'Add API key', 'Add an account for ' + group.title, () => openAccountForm(group), 'text-button')); section.appendChild(footer); }
      } root.appendChild(section);
    });
  }
  function usageSummary() {
    const entries = []; const shades = new Map();
    for (const group of accountGroups) for (const account of state.accounts.filter(item => item.provider === group.provider)) {
      const metrics = (state.usage[account.id]?.metrics || []).filter(metric => typeof metric.usedPercent === 'number' && Number.isFinite(metric.usedPercent));
      if (!metrics.length) continue; const binding = metrics.reduce((best, metric) => metric.usedPercent > best.usedPercent ? metric : best); const used = percent(binding.usedPercent); const k = shades.get(account.provider) || 0; shades.set(account.provider, k + 1);
      entries.push({ account, binding, used, color: k ? `color-mix(in srgb, ${providerColor(account.provider)} ${Math.max(44, 100 - k * 28)}%, white)` : providerColor(account.provider) });
    }
    const eligible = new Set(entries.map(entry => entry.account.id)); const missing = state.accounts.filter(account => account.provider !== 'openai' && account.provider !== 'anthropic' && !eligible.has(account.id)).length;
    return { entries, missing, combined: entries.length ? Math.round(entries.reduce((sum, entry) => sum + entry.used, 0) / entries.length) : 0 };
  }
  function renderUsageStack(root, entries) {
    const previous = new Map([...root.querySelectorAll('[data-account-id]')].map(node => [node.dataset.accountId, node.dataset.width])); root.textContent = '';
    for (const entry of entries) {
      const segment = document.createElement('span'); const width = entry.used / entries.length; const old = previous.get(entry.account.id); segment.className = 'usage-stack-segment'; segment.dataset.accountId = entry.account.id; segment.dataset.width = String(width); segment.style.width = width + '%'; segment.style.background = entry.color; root.appendChild(segment);
      if (old !== undefined && Number(old) !== width && !calm()) play(segment, [{ width: old + '%' }, { width: width + '%' }], { duration: 460, easing: railSpring });
    }
  }
  // Green when usage comes back soon, red when it is days away (log scale from 30 minutes to 5 days).
  function resetColor(at) {
    const hours = Math.max(0.5, Math.min(120, (at - Date.now()) / 3600000));
    return `hsl(${Math.round(130 * (1 - Math.log(hours / 0.5) / Math.log(240)))} 65% 55%)`;
  }
  function renderUsageButton() {
    const summary = usageSummary(); const toggle = el('usage-toggle'); const menu = el('usage-menu');
    toggle.hidden = !summary.entries.length; const title = `AI usage ${summary.combined}% across ${summary.entries.length} accounts`; toggle.title = title; toggle.setAttribute('aria-label', title);
    if (!summary.entries.length) { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); return; }
    if (menu.hidden) return;
    const oldStack = menu.querySelector('.usage-stack'); const stack = oldStack || document.createElement('div'); stack.className = 'usage-stack usage-menu-stack'; renderUsageStack(stack, summary.entries); menu.textContent = '';
    const head = document.createElement('div'); head.className = 'usage-menu-head'; const heading = document.createElement('span'); heading.textContent = 'AI usage — all accounts';
    const refresh = button('', 'Refresh usage', () => send({ type: 'refreshUsage' }), 'icon-button', 'refresh'); if (Object.values(state.usage).some(usage => usage?.loading)) refresh.firstChild.classList.add('spinning'); head.append(heading, refresh);
    const big = document.createElement('div'); big.className = 'usage-big'; const number = document.createElement('strong'); number.textContent = summary.combined + '%'; const caption = document.createElement('span'); caption.textContent = 'combined usage'; big.append(number, caption);
    const legend = document.createElement('div'); legend.className = 'usage-legend';
    for (const entry of summary.entries) {
      const { account, binding, used, color } = entry; const row = button('', 'View ' + account.label + ' account', () => { selectedAccountProvider = account.provider; saveLocal(); closeMenus(); showPage('accounts'); }, 'usage-legend-row');
      const swatch = document.createElement('span'); swatch.className = 'usage-swatch'; swatch.style.background = color; const name = document.createElement('span'); name.className = 'usage-legend-name'; name.textContent = (providerNames[account.provider] || account.provider) + ' · ' + account.label;
      const value = document.createElement('span'); value.className = 'usage-legend-value'; value.textContent = Math.round(used) + '%';
      const reset = resetIn(binding.resetsAt); const time = document.createElement('span'); time.className = 'usage-legend-reset'; time.textContent = reset;
      if (reset) { time.style.color = resetColor(binding.resetsAt); time.title = binding.label + ' resets in ' + reset; }
      row.append(swatch, name, value, time); legend.appendChild(row);
    }
    menu.append(head, big, stack, legend);
    if (summary.missing) { const foot = document.createElement('div'); foot.className = 'usage-foot'; foot.textContent = summary.missing + ' account' + (summary.missing === 1 ? '' : 's') + ' without usage data'; menu.appendChild(foot); }
    menu.appendChild(button('Manage accounts', 'Manage accounts', () => { closeMenus(); showPage('accounts'); }, 'text-button'));
  }
  el('usage-toggle').onclick = () => { const menu = el('usage-menu'); const wasHidden = menu.hidden; closeMenus(); closeSettings(); el('recent-menu').hidden = true; el('recent-toggle').setAttribute('aria-expanded', 'false'); closeSendMenu(); menu.hidden = !wasHidden; el('usage-toggle').setAttribute('aria-expanded', String(wasHidden)); if (wasHidden) { renderUsageButton(); if (!calm()) play(menu, [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 220, easing: popEasing }); } };
  setInterval(() => { if (page === 'accounts') renderAccounts(); }, 60000);

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
      meta.textContent = [profile.model, profile.effort, profile.speed, profile.mode === 'edit' ? 'can edit' : 'read-only', profile.tools === false ? 'no tools' : ''].filter(Boolean).join(' · ');
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
    el('instruction-upload-field').hidden = editing || !skill;
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

  // Reads an uploaded Markdown file into skill form fields. Frontmatter name and description win; otherwise the
  // name comes from the file name. Must accept what SKILL_NAME in src/instructions/store.ts accepts.
  function skillFromMarkdown(fileName, text) {
    text = text.replace(/^﻿/, '');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    const field = key => {
      const raw = frontmatter ? (new RegExp('^' + key + ':[ \\t]*(.+)$', 'm').exec(frontmatter[1]) || [])[1] || '' : '';
      const value = raw.trim(); const quoted = /^(["'])(.*)\1$/.exec(value);
      return /^[>|]/.test(value) ? '' : (quoted ? quoted[2] : value).replace(/\s+/g, ' ').trim();
    };
    const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 64).replace(/-+$/, '');
    const base = fileName.replace(/\.(md|markdown)$/i, '');
    return {
      name: slug(field('name')) || (base.toLowerCase() === 'skill' ? '' : slug(base)),
      description: field('description').slice(0, 200),
      body: frontmatter ? text.slice(frontmatter[0].length).replace(/^\s+/, '') : text
    };
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
    el('subagent-tools').checked = profile?.tools !== false;
    updateSubagentOptions(profile);
  }

  function updateModelSources() {
    const provider = el('model-provider').value;
    const cursor = provider === 'cursor-acp';
    el('model-backend-field').hidden = cursor;
    el('model-cursor-field').hidden = !cursor;
    // Any slug can be typed; models Cursor has listed are offered as suggestions.
    const cursorOptions = el('model-cursor-options');
    cursorOptions.textContent = '';
    const entries = [{ value: 'auto', name: 'Auto' }, ...(state.cursorBackends || []).filter(item => item.value !== 'auto')];
    const seen = new Set();
    for (const entry of entries) { if (seen.has(entry.value)) continue; seen.add(entry.value); const option = document.createElement('option'); option.value = entry.value; option.textContent = entry.name; cursorOptions.appendChild(option); }
    el('model-cursor-backend').required = cursor;
    if (cursor && !el('model-cursor-backend').value.trim()) el('model-cursor-backend').value = 'auto';
    const account = el('model-account'); const previousAccount = account.value;
    account.textContent = '';
    const options = cursor ? [{ value: 'cursor-login', label: 'Cursor sign-in' }] : [
      { value: 'default', label: 'Default account for provider' },
      ...state.accounts.filter(item => item.provider === provider).map(item => ({ value: item.id, label: item.label + (item.email ? ' (' + item.email + ')' : '') })),
    ];
    for (const item of options) { const option = document.createElement('option'); option.value = item.value; option.textContent = item.label; account.appendChild(option); }
    if (options.some(item => item.value === previousAccount)) account.value = previousAccount;
    el('model-form-help').textContent = cursor ? 'Type auto or any Cursor model slug ("agent models" in a terminal lists them). Models Cursor has listed are suggested.' : provider === 'codex-cli' || provider === 'claude-cli' ? 'Use default or enter a model ID.' : 'Enter the provider model ID.';
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
    el('model-cursor-backend').value = model?.provider === 'cursor-acp' ? model.backend : '';
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
    for (const [menuId, buttonId] of [['model-menu', 'model-picker'], ['speed-options', 'speed-picker'], ['effort-options', 'effort-picker'], ['agents-menu', 'agents-picker'], ['approval-menu', 'approval'], ['usage-menu', 'usage-toggle']]) {
      el(menuId).hidden = true; el(buttonId).setAttribute('aria-expanded', 'false');
    }
  }

  // The chat's running subagents, under the composer. Rows update in place so hover and focus survive streaming text.
  function renderAgents() {
    const running = Object.values(state.subagents?.[state.activeSessionId || ''] || {}).filter(agent => agent.state === 'running');
    const control = el('agents-control'), menu = el('agents-menu');
    if (!running.length) { if (!control.hidden) { control.hidden = true; menu.hidden = true; el('agents-picker').setAttribute('aria-expanded', 'false'); } return; }
    control.hidden = false;
    const count = running.length + ' agent' + (running.length === 1 ? '' : 's');
    // Just the number on the chip, so the model, speed and effort pickers keep their room.
    el('agents-label').textContent = String(running.length);
    el('agents-picker').title = count + ' running. Show them';
    el('agents-picker').setAttribute('aria-label', el('agents-picker').title);
    const rows = new Map([...menu.children].map(row => [row.dataset.agentId, row]));
    running.forEach((agent, index) => {
      let row = rows.get(agent.id);
      if (!row) {
        row = document.createElement('button'); row.type = 'button'; row.className = 'agent-row'; row.dataset.agentId = agent.id; row.setAttribute('role', 'menuitem');
        row.onclick = () => { closeMenus(); openedSubagent = agent.id; renderFeed(); };
        const head = document.createElement('span'); head.className = 'agent-row-head';
        const name = document.createElement('span'); name.className = 'agent-row-name';
        const model = document.createElement('span'); model.className = 'agent-row-model';
        head.append(name, model);
        const activity = document.createElement('span'); activity.className = 'agent-row-activity';
        row.append(head, activity);
      }
      rows.delete(agent.id);
      const last = agent.messages[agent.messages.length - 1]?.text.trim().split('\n').filter(Boolean).pop() || 'Starting…';
      row.querySelector('.agent-row-name').textContent = agent.title;
      row.querySelector('.agent-row-model').textContent = agent.model || '';
      row.querySelector('.agent-row-activity').textContent = last;
      row.title = 'Open ' + agent.title + "'s conversation";
      row.setAttribute('aria-current', String(openedSubagent === agent.id));
      if (menu.children[index] !== row) menu.insertBefore(row, menu.children[index] || null);
    });
    for (const row of rows.values()) row.remove();
  }

  const approvalModes = { ask: ['Ask approval', 'shield', 'Ask before running tools'], auto: ['Approve for me', 'bolt', 'Routine actions run automatically; risky ones still ask'], full: ['Full access', 'warning', 'No approval prompts, unrestricted file and network access'] };
  function renderApproval() {
    const mode = Object.hasOwn(approvalModes, state.approvalMode) ? state.approvalMode : 'ask';
    const [label, glyph, desc] = approvalModes[mode], approval = el('approval');
    approval.dataset.mode = mode; approval.title = `${label}: ${desc}. Click to change.`; approval.setAttribute('aria-label', approval.title);
    el('approval-label').textContent = label; el('approval-icon').textContent = glyph;
    const menu = el('approval-menu'); menu.textContent = '';
    for (const [value, [name, iconName, description]] of Object.entries(approvalModes)) {
      const option = document.createElement('button'); option.type = 'button'; option.className = 'send-option'; option.setAttribute('role', 'menuitemradio'); option.dataset.mode = value; option.setAttribute('aria-checked', String(value === mode));
      const glyph = document.createElement('span'); glyph.className = 'symbol send-option-icon'; glyph.textContent = iconName;
      const copy = document.createElement('span'); copy.className = 'send-option-copy';
      const title = document.createElement('span'); title.className = 'send-option-title'; title.textContent = name;
      const detail = document.createElement('span'); detail.className = 'send-option-desc'; detail.textContent = description; copy.append(title, detail); option.append(glyph, copy);
      if (value === mode) { const check = document.createElement('span'); check.className = 'symbol approval-check'; check.textContent = 'check'; option.append(check); }
      option.onclick = () => { state.approvalMode = value; closeMenus(); renderApproval(); send({ type: 'setApproval', mode: value }); }; menu.append(option);
    }
    fitComposerActions();
  }

  const popEasing = 'cubic-bezier(.34, 1.56, .64, 1)';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  function fitComposerActions() {
    const actions = el('compose-actions'); if (!actions.clientWidth) return;
    const wasCompact = actions.classList.contains('compact'); actions.classList.remove('compact');
    const tools = el('compose-tools'), label = el('model-picker-label');
    const compact = tools.scrollWidth + el('compose-send').offsetWidth + 6 > actions.clientWidth || label.scrollWidth > label.clientWidth + 1;
    actions.classList.toggle('compact', compact);
    if (compact !== wasCompact && !reduceMotion.matches) el('approval').animate([{ transform: 'scale(.82)' }, { transform: 'none' }], { duration: 440, easing: popEasing });
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

  const featureInfo = [
    { key: 'activityRail', icon: 'view_sidebar', title: 'Activity rail', desc: 'A rail left of the chat: gray while a chat runs, amber when it needs you, blue when it finished while you were elsewhere. When off, the top chat tabs return.' },
    { key: 'autoName', icon: 'title', title: 'Name chats automatically', desc: 'A name model turns your first message into a short title. Renaming a chat yourself keeps your name.' },
    { key: 'reviewAgent', icon: 'rate_review', title: 'Separate review agent', desc: 'A separate read-only agent reviews each /job round. When off, the chat agent reviews its own work in the same chat.' },
    { key: 'fileSummaries', icon: 'summarize', title: 'File summaries', desc: 'When an agent first reads a file or edits one, a summary model writes a short summary of it: its purpose and bare definitions. Agents check summaries before reading whole files.' },
    { key: 'smartAuto', icon: 'auto_awesome', title: 'Smart Auto', desc: 'Adds Smart Auto to the model menu. For each message you send, a decider model picks a model and effort from your ranked list.' },
    { key: 'shareRules', icon: 'share', title: 'Share global rules and skills', desc: 'Before each Claude or Codex turn, copies your all-workspace rules and skills into that account. DSH already reads them.' },
    { key: 'editorContext', icon: 'code', title: 'Send editor context', desc: 'Adds your open files, cursor position, selection and diagnostics to each message.' },
    { key: 'mirror', icon: 'content_copy', title: 'Private workspace copy', desc: 'Each new chat edits its own copy of the workspace. Turn off to let agents edit your real files, so they see your changes and each other\'s. Applies to new chats.' },
    { key: 'updateChecks', icon: 'update', title: 'Offer optional updates', desc: 'Checks for DSH-IDE and DSH updates at startup. Required updates still apply.' },
  ];
  let customizeKey = '';

  function featureModelFields(stateKey, saveType, modelLabel, emptyLabel, helperWithModel, helperWithoutModel) {
    const models = state.models.filter(item => item.enabled !== false);
    const current = state[stateKey] || {};
    const model = models.find(item => item.id === current.model);
    const detail = document.createElement('div'); detail.className = 'feature-detail';
    const field = (label, items, value, onchange) => {
      const wrap = document.createElement('label'); wrap.textContent = label;
      const select = document.createElement('select'); fillSelect(select, items, value); select.onchange = () => onchange(select.value);
      wrap.appendChild(select); detail.appendChild(wrap); return wrap;
    };
    const save = next => { state[stateKey] = next; customizeKey = ''; renderCustomize(); send({ type: saveType, [stateKey]: next }); };
    field(modelLabel, [{ value: '', label: emptyLabel }, ...models.map(item => ({ value: item.id, label: item.name }))], current.model || '',
      value => save({ model: value || undefined }));
    if (model) {
      if (model.effortOptions?.length) field('Effort', [{ value: '', label: 'Default' }, ...model.effortOptions.map(value => ({ value, label: value }))], current.effort || '',
        value => save({ ...current, effort: value || undefined }));
      if (model.speedOptions?.length) field('Speed', [{ value: '', label: 'Default' }, ...model.speedOptions.map(item => ({ value: item.label, label: item.label }))], current.speed || '',
        value => save({ ...current, speed: value || undefined }));
    }
    const help = document.createElement('p'); help.className = 'helper';
    help.textContent = model ? helperWithModel : helperWithoutModel;
    detail.appendChild(help);
    return detail;
  }

  /** Smart Auto's ranked models, smartest first. Every change is saved at once. */
  function smartAutoRankFields() {
    const models = state.models.filter(item => item.enabled !== false);
    const ranks = state.smartAutoRanks;
    const detail = document.createElement('div'); detail.className = 'feature-detail smart-ranks';
    const heading = document.createElement('div'); heading.className = 'smart-ranks-title'; heading.textContent = 'Ranked models (1 = smartest)';
    detail.appendChild(heading);
    const save = next => { state.smartAutoRanks = next; customizeKey = ''; renderCustomize(); renderPicker(); send({ type: 'saveSmartAutoRanks', ranks: next }); };
    const replace = (index, rank) => save(ranks.map((item, at) => at === index ? rank : item));
    const move = (index, by) => { const next = [...ranks]; [next[index], next[index + by]] = [next[index + by], next[index]]; save(next); };
    ranks.forEach((rank, index) => {
      const model = models.find(item => item.id === rank.model);
      const item = document.createElement('div'); item.className = 'smart-rank-item';
      const row = document.createElement('div'); row.className = 'smart-rank';
      const number = document.createElement('span'); number.className = 'smart-rank-number'; number.textContent = String(index + 1);
      const modelSelect = document.createElement('select'); modelSelect.setAttribute('aria-label', 'Model for rank ' + (index + 1));
      fillSelect(modelSelect, [...(model ? [] : [{ value: rank.model, label: rank.model + ' (missing)' }]), ...models.map(item => ({ value: item.id, label: item.name }))], rank.model);
      modelSelect.onchange = () => replace(index, { model: modelSelect.value, note: rank.note });
      row.append(number, modelSelect);
      if (model?.effortOptions?.length) {
        const effortSelect = document.createElement('select'); effortSelect.setAttribute('aria-label', 'Effort for rank ' + (index + 1));
        fillSelect(effortSelect, [{ value: '', label: 'Default' }, ...model.effortOptions.map(value => ({ value, label: value }))], rank.effort || '');
        effortSelect.onchange = () => replace(index, { ...rank, effort: effortSelect.value || undefined });
        row.appendChild(effortSelect);
      }
      const up = button('', 'Move up', () => move(index, -1), 'icon-button', 'arrow_upward'); up.disabled = index === 0;
      const down = button('', 'Move down', () => move(index, 1), 'icon-button', 'arrow_downward'); down.disabled = index === ranks.length - 1;
      row.append(up, down, button('', 'Remove from ranking', () => save(ranks.filter((_, at) => at !== index)), 'icon-button', 'close'));
      const note = document.createElement('input'); note.type = 'text'; note.className = 'smart-rank-note'; note.maxLength = 500;
      note.placeholder = 'When to use it (optional)'; note.value = rank.note || ''; note.setAttribute('aria-label', 'Note for rank ' + (index + 1));
      // Saved on blur without a rebuild, so focus can move straight to the next field.
      note.onchange = () => {
        const next = ranks.map((item, at) => at === index ? { ...item, note: note.value.trim() || undefined } : item);
        state.smartAutoRanks = next; customizeKey = customizeStateKey(); send({ type: 'saveSmartAutoRanks', ranks: next });
      };
      item.append(row, note);
      detail.appendChild(item);
    });
    if (models.length && ranks.length < 12) detail.appendChild(button('Add model', 'Add a model to the ranking', () => save([...ranks, { model: models[0].id }]), 'text-button'));
    const help = document.createElement('p'); help.className = 'helper';
    help.textContent = ranks.length ? 'Notes tell the decider when to pick a model. The same model can appear more than once with different efforts.' : 'Add the models Smart Auto may use, smartest first.';
    detail.appendChild(help);
    return detail;
  }

  const customizeStateKey = () => JSON.stringify([state.features, state.nameModel, state.reviewModel, state.summaryModel, state.deciderModel, state.smartAutoRanks, state.models.map(item => [item.id, item.enabled, item.effortOptions, item.speedOptions])]);

  function renderCustomize() {
    const root = el('feature-list');
    // Skip identical rebuilds so an open select is not reset by unrelated state messages.
    const key = customizeStateKey();
    if (key === customizeKey && root.childElementCount) return;
    customizeKey = key;
    rebuild(root, () => {
      for (const feature of featureInfo) {
        const enabled = !!state.features[feature.key];
        const row = settingRow('feature:' + feature.key, feature, enabled, () => {
          state.features = { ...state.features, [feature.key]: !enabled };
          if (feature.key === 'activityRail') renderSessions();
          renderCustomize();
          send({ type: 'setFeature', key: feature.key, enabled: !enabled });
        });
        if (feature.key === 'autoName' && enabled) row.appendChild(featureModelFields('nameModel', 'saveNameModel', 'Name model', 'None (use the first message)', 'Pick a fast, cheap model. It only sees your first message.', 'Without a name model, chats are named after the first message.'));
        if (feature.key === 'reviewAgent' && enabled) row.appendChild(featureModelFields('reviewModel', 'saveReviewModel', 'Review model', 'Choose a model', 'It reads the working copy and checks every criterion.', 'Pick a model, or each /job stops when it reaches review.'));
        if (feature.key === 'smartAuto' && enabled) row.append(featureModelFields('deciderModel', 'saveDeciderModel', 'Decider model', 'Choose a model', 'Pick a fast, cheap model. It sees your message and the last few exchanges, then picks a model below.', 'Pick a decider model to use Smart Auto.'), smartAutoRankFields());
        if (feature.key === 'fileSummaries' && enabled) row.appendChild(featureModelFields('summaryModel', 'saveSummaryModel', 'Summary model', 'Choose a model', 'Pick a fast, cheap model. It runs in the background and only sees the files it summarizes.', 'Pick a model to start writing summaries.'));
        root.appendChild(row);
      }
    });
  }

  // Settings lists are rebuilt on every toggle, so the flip is replayed on the fresh switch, resuming
  // from the position and colors captured off the old one. Later rebuilds mid-flip pick up where it left off.
  const switchFlips = new Map();
  const flipLength = 640;
  function flipSwitch(toggle, flip) {
    const elapsed = performance.now() - flip.start;
    if (!toggle.isConnected) return;
    if (flip.focused && (!document.activeElement || document.activeElement === document.body)) toggle.focus({ preventScroll: true });
    if (calm()) return;
    const thumb = toggle.firstChild;
    const track = getComputedStyle(toggle), dot = getComputedStyle(thumb);
    const run = (node, frames, options) => { const animation = play(node, frames, options); if (animation) animation.currentTime = elapsed; };
    run(thumb, [{ translate: flip.translate }, { translate: dot.translate }], { duration: 560, easing: 'cubic-bezier(.34, 1.56, .5, 1)' });
    // Stretch along the slide, squash on landing, then wobble back to round.
    run(thumb, [{ transform: 'scale(1)' }, { transform: 'scale(1.4, .72)', offset: .22 }, { transform: 'scale(.84, 1.16)', offset: .5 },
      { transform: 'scale(1.06, .95)', offset: .74 }, { transform: 'scale(1)' }], { duration: flipLength, easing: 'ease-out' });
    run(thumb, [{ backgroundColor: flip.dot }, { backgroundColor: dot.backgroundColor }], { duration: 420, easing: 'ease-in-out' });
    run(toggle, [{ backgroundColor: flip.track, borderColor: flip.border }, { backgroundColor: track.backgroundColor, borderColor: track.borderColor }], { duration: 420, easing: 'ease-in-out' });
  }

  /** A titled row with an icon and, when `onToggle` is given, an on/off switch. */
  function settingRow(key, info, enabled, onToggle) {
    const row = keyed(document.createElement('div'), key); row.className = 'feature-row';
    const main = document.createElement('div'); main.className = 'row-main';
    const title = document.createElement('div'); title.className = 'row-title'; title.textContent = info.title;
    const desc = document.createElement('div'); desc.className = 'row-subtitle'; desc.textContent = info.desc;
    main.append(title, desc);
    const head = document.createElement('div'); head.className = 'feature-head';
    const glyph = icon(info.icon); glyph.classList.add('feature-icon');
    head.append(glyph, main);
    if (onToggle) {
      const toggle = button('', (enabled ? 'Turn off: ' : 'Turn on: ') + info.title, () => {
        // Read the old switch before onToggle rebuilds the list; mid-flip reads pick up the animated values.
        const track = getComputedStyle(toggle), dot = getComputedStyle(thumb);
        switchFlips.set(key, { start: performance.now(), translate: dot.translate, dot: dot.backgroundColor, track: track.backgroundColor, border: track.borderColor,
          hot: toggle.matches(':hover'), focused: document.activeElement === toggle });
        onToggle();
      }, 'switch');
      toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(enabled));
      const thumb = document.createElement('span'); thumb.className = 'switch-thumb'; toggle.appendChild(thumb);
      head.appendChild(toggle);
      const flip = switchFlips.get(key);
      if (flip && performance.now() - flip.start < flipLength) {
        toggle.classList.toggle('hot', flip.hot);
        toggle.onmouseleave = () => { toggle.classList.remove('hot'); flip.hot = false; };
        queueMicrotask(() => flipSwitch(toggle, flip));
      } else switchFlips.delete(key);
    }
    row.appendChild(head);
    return row;
  }

  // Mirrors accessibilityStyle() in src/sidebar/view.ts, which sets the same values before first paint.
  const a11yDefaults = { textScale: 1, lineSpacing: 'normal', spacing: 'default', letterSpacing: 'normal', highContrast: false, largeTargets: false, underlineLinks: false };
  const lineScales = { normal: 1, relaxed: 1.2, loose: 1.4 };
  const spaceScales = { compact: 0.75, default: 1, roomy: 1.35 };
  const letterSpacings = { normal: 'normal', wide: '0.04em' };
  function applyAccessibility(value) {
    const a = { ...a11yDefaults, ...value };
    const root = document.documentElement.style;
    root.setProperty('--text-scale', String(a.textScale));
    root.setProperty('--line-scale', String(lineScales[a.lineSpacing] ?? 1));
    root.setProperty('--space-scale', String(spaceScales[a.spacing] ?? 1));
    root.setProperty('--letter-spacing', letterSpacings[a.letterSpacing] ?? 'normal');
    document.body.classList.toggle('a11y-contrast', !!a.highContrast);
    document.body.classList.toggle('a11y-targets', !!a.largeTargets);
    document.body.classList.toggle('a11y-underline', !!a.underlineLinks);
    document.body.classList.toggle('reduce-motion', !!state.features.reduceMotion);
  }

  let a11yKey = '';
  function setAccessibility(patch, save = true) {
    state.accessibility = { ...a11yDefaults, ...state.accessibility, ...patch };
    applyAccessibility(state.accessibility);
    if (save) send({ type: 'saveAccessibility', accessibility: state.accessibility });
  }

  function segmented(label, options, current, onPick) {
    const group = document.createElement('div'); group.className = 'segmented'; group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-label', label);
    for (const [value, text] of options) {
      const choice = button(text, label + ': ' + text, () => onPick(value));
      choice.className = ''; choice.setAttribute('role', 'radio'); choice.setAttribute('aria-checked', String(value === current));
      group.appendChild(choice);
    }
    return group;
  }

  function renderAccessibility() {
    const root = el('a11y-list');
    const a = { ...a11yDefaults, ...state.accessibility };
    // Skip identical rebuilds so a slider being dragged keeps its pointer capture.
    const key = JSON.stringify([a, state.features.reduceMotion]);
    if (key === a11yKey && root.childElementCount) return;
    a11yKey = key;
    const choose = patch => { setAccessibility(patch); renderAccessibility(); };
    rebuild(root, () => {
      const size = settingRow('a11y:text', { icon: 'format_size', title: 'Text size', desc: 'Scales text, icons and controls across the sidebar.' });
      const sizeControl = document.createElement('div'); sizeControl.className = 'a11y-control';
      const scaleRow = document.createElement('div'); scaleRow.className = 'scale-row';
      const small = icon('text_decrease'); const large = icon('text_increase');
      const slider = document.createElement('input'); slider.type = 'range'; slider.min = '85'; slider.max = '160'; slider.step = '5';
      slider.value = String(Math.round(a.textScale * 100)); slider.setAttribute('aria-label', 'Text size');
      const value = document.createElement('span'); value.className = 'scale-value'; value.textContent = slider.value + '%';
      slider.oninput = () => {
        value.textContent = slider.value + '%';
        setAccessibility({ textScale: Number(slider.value) / 100 }, false);
        a11yKey = JSON.stringify([state.accessibility, state.features.reduceMotion]);
      };
      slider.onchange = () => send({ type: 'saveAccessibility', accessibility: state.accessibility });
      scaleRow.append(small, slider, large, value);
      const sample = document.createElement('p'); sample.className = 'a11y-sample'; sample.textContent = 'The quick brown fox reviews three pending edits.';
      sizeControl.append(scaleRow, sample);
      size.appendChild(sizeControl);

      const choice = (rowKey, info, label, options, current, field) => {
        const row = settingRow(rowKey, info);
        const control = document.createElement('div'); control.className = 'a11y-control';
        control.appendChild(segmented(label, options, current, picked => choose({ [field]: picked })));
        row.appendChild(control);
        return row;
      };
      const toggle = (rowKey, info, field) => settingRow(rowKey, info, !!a[field], () => choose({ [field]: !a[field] }));
      const motion = settingRow('a11y:motion', { icon: 'animation', title: 'Reduce motion', desc: 'Turns off sidebar animations, including the activity rail.' }, !!state.features.reduceMotion, () => {
        const enabled = !state.features.reduceMotion;
        state.features = { ...state.features, reduceMotion: enabled };
        applyAccessibility(state.accessibility);
        renderAccessibility();
        send({ type: 'setFeature', key: 'reduceMotion', enabled });
      });
      const reset = button('Reset to defaults', 'Reset accessibility settings to defaults', () => choose({ ...a11yDefaults }), 'secondary-button a11y-reset');
      root.append(
        size,
        choice('a11y:line', { icon: 'format_line_spacing', title: 'Line spacing', desc: 'Space between lines in chat messages.' }, 'Line spacing',
          [['normal', 'Normal'], ['relaxed', 'Relaxed'], ['loose', 'Loose']], a.lineSpacing, 'lineSpacing'),
        choice('a11y:spacing', { icon: 'density_medium', title: 'Spacing', desc: 'Room between messages, rows and controls.' }, 'Spacing',
          [['compact', 'Compact'], ['default', 'Default'], ['roomy', 'Roomy']], a.spacing, 'spacing'),
        choice('a11y:letters', { icon: 'format_letter_spacing', title: 'Letter spacing', desc: 'Wider letters can be easier to read, including with dyslexia.' }, 'Letter spacing',
          [['normal', 'Normal'], ['wide', 'Wide']], a.letterSpacing, 'letterSpacing'),
        toggle('a11y:contrast', { icon: 'contrast', title: 'Higher contrast', desc: 'Full-strength secondary text, stronger borders and thicker focus outlines.' }, 'highContrast'),
        toggle('a11y:targets', { icon: 'touch_app', title: 'Larger click targets', desc: 'Bigger buttons, menu items and rail tabs.' }, 'largeTargets'),
        toggle('a11y:underline', { icon: 'format_underlined', title: 'Underline links', desc: 'Underlines links and text buttons so they do not rely on color alone.' }, 'underlineLinks'),
        motion,
        reset,
      );
    });
  }

  const syncBusy = { connecting: 'Connecting to GitHub…', uploading: 'Uploading to GitHub…', downloading: 'Downloading from GitHub…', checking: 'Checking GitHub for changes…' };
  let syncKey = '';
  function renderSync() {
    const root = el('sync-list');
    const sync = state.sync || { connected: false, auto: true };
    // Skip identical rebuilds so focus stays on the button you just used.
    const key = JSON.stringify(sync);
    if (key === syncKey && root.childElementCount) return;
    syncKey = key;
    const busy = !!sync.busy;
    const actions = items => {
      const row = document.createElement('div'); row.className = 'sync-actions';
      for (const [label, title, action, className] of items) {
        const item = button(label, title, () => send({ type: 'syncAction', action }), className || 'secondary-button');
        item.disabled = busy; row.appendChild(item);
      }
      return row;
    };
    const note = (text, className = 'sync-note') => { const line = document.createElement('p'); line.className = className; line.textContent = text; return line; };
    rebuild(root, () => {
      const status = sync.connected
        ? settingRow('sync:status', { icon: 'cloud_done', title: 'Connected as ' + (sync.account || 'GitHub'), desc: sync.lastSync ? 'Last synced ' + new Date(sync.lastSync).toLocaleString() : 'Not synced yet' })
        : settingRow('sync:status', { icon: 'cloud_off', title: 'Not connected', desc: 'Sign in with GitHub. If your account already has a DSH config from another PC, you can download it.' });
      status.appendChild(sync.connected
        ? actions([['Upload now', 'Upload this PC\'s config to GitHub', 'upload'], ['Download', 'Replace this PC\'s config with the GitHub copy', 'download'], ['Open gist', 'Open the config gist on GitHub', 'openGist', 'text-button'], ['Disconnect', 'Stop syncing on this PC (the gist stays on GitHub)', 'disconnect', 'text-button']])
        : actions([['Connect GitHub', 'Sign in with GitHub and start syncing', 'connect', 'primary-button']]));
      if (sync.busy) status.appendChild(note(syncBusy[sync.busy] || 'Working…'));
      if (sync.error) status.appendChild(note(sync.error, 'sync-note sync-error'));
      root.appendChild(status);
      if (sync.connected && sync.conflict) {
        const items = sync.conflict;
        const conflict = settingRow('sync:conflict', { icon: 'sync_problem', title: 'Sync is paused',
          desc: items.length ? 'Changed on both this PC and GitHub: ' + items.join(', ') + '. Everything else is merged once you choose.' : 'Config changed on both this PC and GitHub. Choose which copy to keep.' });
        conflict.appendChild(actions([['Keep GitHub copy', 'Use the GitHub version of the items changed on both', 'keepRemote'], ['Keep this PC', 'Use this PC\'s version of the items changed on both', 'keepLocal']]));
        root.appendChild(conflict);
      }
      if (sync.connected) {
        root.appendChild(settingRow('sync:auto', { icon: 'sync', title: 'Sync automatically', desc: 'Uploads a few seconds after you change synced config, and picks up changes from your other PCs at startup. If both sides changed, DSH asks first.' }, !!sync.auto, () => {
          state.sync = { ...sync, auto: !sync.auto };
          renderSync();
          send({ type: 'setSyncAuto', enabled: !sync.auto });
        }));
      }
    });
  }

  function render() {
    el('view-title').textContent = { chat: 'Chats', accounts: 'Accounts', models: 'Models', subagents: 'Subagents', instructions: 'Behavior', toolcalls: 'Toolpacks', customize: 'Customize', accessibility: 'Accessibility', sync: 'Sync' }[page];
    for (const name of settingsPages) el(name).classList.toggle('current', page === name);
    el('settings-toggle').setAttribute('aria-pressed', String(settingsPages.includes(page)));
    el('accounts').setAttribute('aria-pressed', String(page === 'accounts'));
    renderNotice(); renderPicker(); renderApproval(); renderSessions(); renderFeed(); renderUsageButton();
    if (page === 'accounts') renderAccounts();
    if (page === 'subagents') renderSubagents();
    if (page === 'instructions') renderInstructions();
    if (page === 'models') { renderModels(); if (!el('model-form').hidden) updateModelSources(); }
    if (page === 'toolcalls') renderToolpacks();
    if (page === 'customize') renderCustomize();
    if (page === 'accessibility') renderAccessibility();
    if (page === 'sync') renderSync();
  }

  el('recent-toggle').onclick = () => { const menu = el('recent-menu'); const wasHidden = menu.hidden; closeMenus(); menu.hidden = !wasHidden; el('recent-toggle').setAttribute('aria-expanded', String(!menu.hidden)); };
  for (const [buttonId, menuId] of [['model-picker', 'model-menu'], ['speed-picker', 'speed-options'], ['effort-picker', 'effort-options'], ['agents-picker', 'agents-menu'], ['approval', 'approval-menu']]) {
    el(buttonId).onclick = () => { const wasHidden = el(menuId).hidden; closeMenus(); el(menuId).hidden = !wasHidden; el(buttonId).setAttribute('aria-expanded', String(wasHidden)); if (menuId === 'model-menu') placeModelMenu(); };
  }
  el('settings-toggle').onclick = () => { const menu = el('settings-menu'); const wasHidden = menu.hidden; closeMenus(); menu.hidden = !wasHidden; el('settings-toggle').setAttribute('aria-expanded', String(!menu.hidden)); };
  el('customize').onclick = () => showPage(page === 'customize' ? 'chat' : 'customize');
  el('accessibility').onclick = () => showPage(page === 'accessibility' ? 'chat' : 'accessibility');
  el('sync').onclick = () => showPage(page === 'sync' ? 'chat' : 'sync');
  document.addEventListener('click', event => {
    if (!event.target.closest('.settings-wrap')) closeSettings();
    if (!event.target.closest('.recent-wrap')) { el('recent-menu').hidden = true; el('recent-toggle').setAttribute('aria-expanded', 'false'); }
    if (!event.target.closest('.model-picker-wrap') && !event.target.closest('.option-wrap') && !event.target.closest('.usage-wrap')) closeMenus();
    if (!event.target.closest('.send-wrap')) closeSendMenu();
  });
  function slashMenuOpen() { return slashMenuEl && !slashMenuEl.hidden; }

  function closeSlashMenu() {
    if (!slashMenuEl) return;
    slashMenuEl.hidden = true;
    slashMatches = [];
    slashHighlight = 0;
    const prompt = el('prompt');
    prompt.removeAttribute('aria-activedescendant');
    prompt.removeAttribute('aria-controls');
    prompt.removeAttribute('aria-expanded');
    prompt.removeAttribute('aria-autocomplete');
    prompt.removeAttribute('role');
  }

  function ensureSlashMenu() {
    if (slashMenuEl) return slashMenuEl;
    slashMenuEl = document.createElement('div');
    slashMenuEl.id = 'slash-menu';
    slashMenuEl.className = 'slash-menu';
    slashMenuEl.hidden = true;
    slashMenuEl.setAttribute('role', 'listbox');
    slashMenuEl.setAttribute('aria-label', 'Slash commands');
    slashMenuEl.onmousedown = event => event.preventDefault();
    el('composer').appendChild(slashMenuEl);
    return slashMenuEl;
  }

  function pickSlashCommand(command) {
    const prompt = el('prompt');
    prompt.value = '/' + command.name + ' ';
    closeSlashMenu();
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  }

  function renderSlashMenu() {
    const menu = ensureSlashMenu();
    menu.textContent = '';
    if (!slashMatches.length) { closeSlashMenu(); return; }
    slashHighlight = Math.min(slashHighlight, slashMatches.length - 1);
    slashMatches.forEach((command, index) => {
      const row = button('', command.description, () => pickSlashCommand(command), 'slash-option');
      row.id = 'slash-option-' + index;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === slashHighlight));
      if (command.usage) row.title = command.usage;
      const name = document.createElement('span'); name.className = 'slash-name'; name.textContent = '/' + command.name;
      const desc = document.createElement('span'); desc.className = 'slash-desc'; desc.textContent = command.description;
      row.append(name, desc);
      menu.appendChild(row);
    });
    menu.hidden = false;
    const prompt = el('prompt');
    prompt.setAttribute('role', 'combobox');
    prompt.setAttribute('aria-controls', 'slash-menu');
    prompt.setAttribute('aria-expanded', 'true');
    prompt.setAttribute('aria-autocomplete', 'list');
    prompt.setAttribute('aria-activedescendant', 'slash-option-' + slashHighlight);
  }

  function slashTokenAt(value, caret) {
    if (!value.startsWith('/')) return null;
    const end = value.search(/\s/);
    const tokenEnd = end < 0 ? value.length : end;
    if (caret > tokenEnd) return null;
    return value.slice(1, caret);
  }

  function updateSlashMenu() {
    const prompt = el('prompt');
    const query = slashTokenAt(prompt.value, prompt.selectionStart ?? prompt.value.length);
    if (query === null) { closeSlashMenu(); return; }
    // Running toolpacks double as commands: "/roblox" turns that pack on for the rest of the chat.
    const packs = (state.toolpacks || []).filter(pack => pack.enabled && pack.state === 'running')
      .map(pack => ({ name: pack.id, description: 'Turn on the ' + pack.id + ' toolpack for this chat', usage: '/' + pack.id }));
    slashMatches = [...(state.slashCommands || []), ...packs].filter(item => item.name.toLowerCase().startsWith(query.toLowerCase()));
    if (!slashMatches.length) { closeSlashMenu(); return; }
    slashHighlight = 0;
    renderSlashMenu();
  }

  document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeSlashMenu(); closeSettings(); el('recent-menu').hidden = true; el('recent-toggle').setAttribute('aria-expanded', 'false'); closeMenus(); closeSendMenu(); } });
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
  document.querySelectorAll('#send-menu .send-option').forEach((option, index, options) => {
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
  el('instruction-upload').onclick = () => el('instruction-upload-input').click();
  el('instruction-upload-input').onchange = async event => {
    const file = event.target.files[0]; event.target.value = '';
    if (!file) return;
    state.error = undefined;
    if (file.size > 256 * 1024) state.error = `${file.name} must be under 256 KB.`;
    else {
      try {
        const skill = skillFromMarkdown(file.name, await file.text());
        if (skill.name) el('instruction-name').value = skill.name;
        if (skill.description) el('instruction-description').value = skill.description;
        el('instruction-content').value = skill.body;
      } catch {
        state.error = `Could not read ${file.name}.`;
      }
    }
    renderNotice();
    (el('instruction-name').value ? el('instruction-content') : el('instruction-name')).focus();
  };
  el('instruction-form').onsubmit = event => {
    event.preventDefault();
    const form = el('instruction-form'); const content = el('instruction-content');
    if (content.disabled) return;
    const kind = form.dataset.kind; const name = el('instruction-name').value.trim();
    if (!form.dataset.id && kind === 'skill' && !name) { el('instruction-name').focus(); return; }
    send({ type: 'saveInstruction', id: form.dataset.id || undefined, kind, scope: el('instruction-scope').value, file: el('instruction-file').value,
      name, description: el('instruction-description').value.trim(), content: content.value });
  };
  el('prompt').oninput = () => updateSlashMenu();
  el('prompt').onkeyup = event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) updateSlashMenu(); };
  el('prompt').onclick = () => updateSlashMenu();
  el('prompt').onblur = () => { setTimeout(() => { if (!slashMenuEl?.contains(document.activeElement)) closeSlashMenu(); }, 120); };
  el('prompt').onkeydown = event => {
    if (slashMenuOpen()) {
      if (event.key === 'Escape') { event.preventDefault(); closeSlashMenu(); return; }
      if (event.key === 'ArrowDown') { event.preventDefault(); slashHighlight = (slashHighlight + 1) % slashMatches.length; renderSlashMenu(); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); slashHighlight = (slashHighlight + slashMatches.length - 1) % slashMatches.length; renderSlashMenu(); return; }
      if (event.key === 'Tab' || event.key === 'Enter') { event.preventDefault(); pickSlashCommand(slashMatches[slashHighlight]); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); el('composer').requestSubmit(); }
  };
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
      effort: el('subagent-effort').value || undefined, speed: el('subagent-speed').value || undefined, mode: el('subagent-mode').value, tools: el('subagent-tools').checked };
    if (profile.name && profile.model) send({ type: 'saveSubagent', originalName: el('subagent-form').dataset.originalName || undefined, profile });
  };
  el('add-model').onclick = () => openModelForm();
  el('model-provider').onchange = () => { const provider = el('model-provider').value; if ((provider === 'codex-cli' || provider === 'claude-cli') && !el('model-backend').value.trim()) el('model-backend').value = 'default'; updateModelSources(); };
  el('model-cancel').onclick = () => { el('model-form').hidden = true; };
  el('model-form').onsubmit = event => {
    event.preventDefault(); const provider = el('model-provider').value;
    const backend = provider === 'cursor-acp' ? el('model-cursor-backend').value.trim() : el('model-backend').value.trim();
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
        if (unread.delete(message.sessionId)) saveLocal();
        for (const table of [state.timeline, state.messages, state.subagents, state.runStates, state.queues, state.jobs]) delete table?.[message.sessionId];
        jobBarExpanded.delete(message.sessionId);
        break;
      case 'jobState':
        if (message.job) state.jobs[message.sessionId] = message.job;
        else delete state.jobs[message.sessionId];
        break;
      case 'queueState': (state.queues ||= {})[message.sessionId] = message.items || []; renderQueue(); break;
      case 'accountState': state.providerLabel = message.provider; state.accountLabel = message.label; state.accountConnected = message.connected; break;
      case 'accountsState': state.accounts = message.accounts || []; state.cursor = message.cursor || state.cursor; break;
      case 'usageState': state.usage = message.usage || {}; break;
      case 'accountSaved': el('account-form').hidden = true; el('account-key').value = ''; el('account-submit').disabled = false; state.error = undefined; break;
      case 'modelSaved': el('model-form').hidden = true; state.error = undefined; break;
      case 'modelRemoveFailed': removingModels.delete(message.name); break;
      case 'subagentProfilesState': state.subagentProfiles = message.profiles || []; if (page === 'subagents') renderSubagents(); break;
      case 'toolpacksState': state.toolpacks = message.packs || []; state.toolpackError = message.error; if (page === 'toolcalls') renderToolpacks(); break;
      case 'subagentSaved': el('subagent-form').hidden = true; state.error = undefined; break;
      case 'instructionsState': state.instructions = message.items || []; break;
      case 'customizeState':
        state.features = message.features || state.features; state.nameModel = message.nameModel || {}; state.reviewModel = message.reviewModel || {}; state.summaryModel = message.summaryModel || {};
        state.deciderModel = message.deciderModel || {}; state.smartAutoRanks = message.smartAutoRanks || [];
        state.accessibility = message.accessibility || state.accessibility;
        applyAccessibility(state.accessibility);
        break;
      case 'syncState': state.sync = message.sync || state.sync; break;
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
          // Delegated subagents can outlive the turn; the host reports how they end.
          for (const agent of Object.values(state.subagents[message.sessionId] || {})) if (agent.state === 'running' && !agent.delegated) agent.state = 'cancelled';
        }
        {
          // A turn that ends on its own while you are looking elsewhere stays unread; cancelling is your own doing.
          const wasBusy = state.runStates[message.sessionId]?.state || 'idle';
          const unseen = message.sessionId !== state.activeSessionId || page !== 'chat' || document.hidden;
          if (message.state === 'idle' && wasBusy !== 'idle' && wasBusy !== 'cancelling' && unseen) { unread.set(message.sessionId, Date.now()); saveLocal(); }
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
        if (message.delegated) agent.delegated = true;
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
      case 'mediaMessage': {
        const timeline = state.timeline[message.sessionId] ||= [];
        // A generated image's box arrives pending, then the same entry is updated when the image is ready or failed.
        const entry = { id: message.entryId, kind: 'media', caption: message.caption, items: message.items || [],
          ...(message.generated ? { generated: true } : {}), ...(message.status ? { status: message.status } : {}) };
        const index = timeline.findIndex(item => item.id === message.entryId);
        if (index >= 0) timeline[index] = entry;
        else { timeline.push(entry); if (message.generated) freshMedia.add(message.entryId); }
        break;
      }
      case 'noteMessage': {
        const timeline = state.timeline[message.sessionId] ||= [];
        if (!timeline.some(item => item.id === message.entryId)) timeline.push({ id: message.entryId, kind: 'note', icon: message.icon, text: message.text });
        break;
      }
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
    if (['userMessage', 'assistantDelta', 'assistantMessage', 'toolEvent', 'subagentEvent', 'toolState', 'diff', 'diffState', 'runState', 'approvalRequest', 'approvalResolved', 'questionRequest', 'questionResolved', 'timelineState', 'jobState', 'mediaMessage'].includes(message.type)) {
      renderFeed();
      if (message.type === 'runState') renderNotice();
      if (/^(approval|question)(Request|Resolved)$|^timelineState$/.test(message.type)) renderRail();
    }
    else render();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) renderRail(); });
  showPage(page);
  send({ type: 'ready' });
})();
