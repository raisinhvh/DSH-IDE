import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { getSidebarHtml, initialSidebarState } from '../dist/sidebar/view.mjs';

test('sidebar loads local icons and a parseable, CSP constrained client', () => {
  const html = getSidebarHtml({ cspSource: 'vscode-webview://test' }, initialSidebarState(), {
    stylesheet: 'vscode-webview://test/sidebar.css', script: 'vscode-webview://test/sidebar.js', font: 'vscode-webview://test/icons.woff2',
  });
  assert.doesNotThrow(() => new vm.Script(readFileSync(new URL('../media/sidebar.js', import.meta.url), 'utf8')));
  assert.match(html, /font-src vscode-webview:\/\/test/);
  assert.match(html, /MaterialSymbolsRounded|icons\.woff2/);
  assert.match(html, /script nonce="[^"]+" src="vscode-webview:\/\/test\/sidebar.js"/);
  assert.match(html, /id="accounts-page"/);
  assert.match(html, /id="models-page"/);
  assert.match(html, /id="account-form"/);
  assert.match(html, /id="model-provider"/);
  assert.match(html, /value="cursor-acp"/);
  assert.match(html, /value="codex-cli"/);
  assert.match(html, /value="claude-cli"/);
  assert.match(html, /id="recent-toggle"/);
  assert.match(html, /id="recent-menu"/);
  assert.match(html, /id="model-picker"/);
  assert.match(html, /id="model-menu"/);
  assert.match(html, /id="speed-options"/);
  assert.match(html, /id="effort-options"/);
  assert.match(html, /id="model-speed-options"/);
  assert.match(html, /id="model-effort-options"/);
  assert.match(html, /id="cancel"/);
  assert.match(html, /id="changes-toggle"/);
  assert.match(html, /id="changes-list"/);
  assert.match(html, /markdown-it\.min\.js/);
  assert.doesNotMatch(html, /<select id="model"/);
  assert.doesNotMatch(html, /brand-mark|Recent chats|Conversation<\/div>/);
});

test('bundled Markdown formats messages without executing raw HTML', () => {
  const context = {};
  vm.runInNewContext(readFileSync(new URL('../media/markdown-it.min.js', import.meta.url), 'utf8'), context);
  const html = context.markdownit({ html: false, linkify: true, breaks: true }).render('**sunny** <script>alert(1)</script>');
  assert.match(html, /<strong>sunny<\/strong>/);
  assert.doesNotMatch(html, /<script>/);
});

test('sidebar escapes account labels in its boot state', () => {
  const state = initialSidebarState();
  state.accounts = [{ id: 'a', provider: 'openai', label: '</script><script>bad()</script>', isDefault: true }];
  const html = getSidebarHtml({ cspSource: 'vscode-webview://test' }, state);
  assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
  assert.match(html, /\\u003c\/script/);
});

test('chat refresh preserves Markdown spacing on unchanged assistant messages', () => {
  const source = readFileSync(new URL('../media/sidebar.js', import.meta.url), 'utf8');
  const renderFeed = source.slice(source.indexOf('  function renderFeed() {'), source.indexOf('  function accountRow('));
  const elements = new Map();
  const node = () => ({ dataset: {}, children: [], className: '', textContent: '', hidden: false, disabled: false, querySelector: () => null,
    appendChild(child) { this.children.push(child); }, classList: { toggle() {} }, setAttribute() {} });
  const feed = node();
  Object.assign(feed, { scrollHeight: 100, scrollTop: 0, clientHeight: 100 });
  elements.set('feed', feed);
  elements.set('send', node());
  elements.set('send-label', node());
  elements.set('cancel', node());
  elements.set('status', node());
  let markdownRenders = 0;
  const context = {
    el(id) { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); },
    document: { createElement: node }, renderChanges() {}, closeSendMenu() {}, renderQueue() {}, fitComposerActions() {}, openedSubagent: '', editingEntryId: '', attachmentsReading: 0,
    button: () => node(), send() {}, icon: () => node(), expandedBatches: new Set(), batchCounts: new Map(),
    renderMarkdown(target, text) { markdownRenders++; target.textContent = text; },
    state: { activeSessionId: 'chat', runStates: {}, subagents: {}, timeline: { chat: [
      { id: 'reply', kind: 'message', role: 'assistant', text: 'Implemented both changes:\n\n- Delegation calls no longer appear.' },
      { id: 'request', kind: 'message', role: 'user', text: 'Keep my\nline breaks.' },
    ] } },
  };
  vm.runInNewContext(renderFeed + '\nrenderFeed(); renderFeed();', context);
  assert.match(feed.children[0].className, /\bmarkdown\b/);
  assert.doesNotMatch(feed.children[1].className, /\bmarkdown\b/);
  assert.equal(markdownRenders, 1);
});

test('sidebar source exposes attachment, edit, and timeline contracts', () => {
  const source = readFileSync(new URL('../media/sidebar.js', import.meta.url), 'utf8');
  assert.match(source, /maxAttachments = 8/);
  assert.match(source, /maxAttachmentBytes = 10 \* 1024 \* 1024/);
  assert.match(source, /maxTotalBytes = 20 \* 1024 \* 1024/);
  assert.match(source, /type: 'saveInstruction'/);
  assert.match(source, /showPage\(page === 'instructions'/);
  assert.match(source, /type: 'editMessage'/);
  assert.match(source, /case 'timelineState'/);
  assert.match(source, /attachmentsReading/);
  assert.match(source, /root\.classList\.toggle\('expanded'/);
  assert.doesNotMatch(source, /group\.provider !== 'openrouter'/);
});

test('timelineState replaces session timeline and clears tool batches', () => {
  const source = readFileSync(new URL('../media/sidebar.js', import.meta.url), 'utf8');
  assert.match(source, /state\.timeline\[sessionId\] = message\.timeline \|\| \[\]/);
  assert.match(source, /state\.tools = \[\]/);
  assert.match(source, /expandedBatches\.clear\(\)/);
  assert.match(source, /feed\.dataset\.view = ''/);
});

test('changes panel toggles expanded class instead of hiding the list', () => {
  const source = readFileSync(new URL('../media/sidebar.js', import.meta.url), 'utf8');
  const renderChanges = source.slice(source.indexOf('  function renderChanges() {'), source.indexOf('  function renderFeed() {'));
  const changes = { hidden: false, classList: { _expanded: false, toggle(_name, on) { this._expanded = on; } } };
  const elements = new Map([
    ['changes', changes],
    ['changes-bulk', { hidden: false }],
    ['changes-toggle', { setAttribute() {} }],
    ['changes-icon', { textContent: '' }],
    ['changes-label', { textContent: '' }],
    ['changes-total', { hidden: false, textContent: '', append() {} }],
    ['changes-list', { textContent: '', appendChild() {} }],
  ]);
  vm.runInNewContext(`${renderChanges}\nstate = { diffs: [{ id: 'd1', path: 'a.ts', additions: 1, deletions: 0 }] };\nchangesExpanded = true;\nrenderChanges();`, {
    el(id) { return elements.get(id); },
    document: { createElement: () => ({ className: '', textContent: '', append() {}, appendChild() {} }) },
    button: () => ({ appendChild() {}, append() {} }),
    state: { diffs: [{ id: 'd1', path: 'a.ts', additions: 1, deletions: 0, state: 'pending' }] },
    changesExpanded: true,
  });
  assert.equal(changes.classList._expanded, true);
});
