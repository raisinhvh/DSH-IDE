import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { getSidebarHtml, initialSidebarState } from '../dist/sidebar/view.mjs';

const source = readFileSync(new URL('../media/sidebar.js', import.meta.url), 'utf8');
const railSource = source.slice(source.indexOf('  const calm = () =>'), source.indexOf('  function renderSessions() {'));

function node(tag = 'div') {
  const n = {
    tagName: tag, dataset: {}, children: [], parent: null, attrs: {}, style: {}, title: '', textContent: '', hidden: false, classes: new Set(), calls: [], moves: 0, scrollTop: 0, offsetHeight: 0,
    get animations() { return this.calls.length; },
    get className() { return [...this.classes].join(' '); },
    set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); },
    get firstChild() { return this.children[0] || null; },
    get nextSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1] || null; },
    append(...items) { for (const item of items) this.appendChild(item); },
    appendChild(child) { return this.insertBefore(child, null); },
    insertBefore(child, ref) {
      if (child.parent) child.moves++;
      child.remove(); child.parent = this;
      const at = ref ? this.children.indexOf(ref) : -1;
      if (at < 0) this.children.push(child); else this.children.splice(at, 0, child);
      return child;
    },
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; },
    querySelector(selector) { return this.children.find(child => child.classes.has(selector.slice(1))) || null; },
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener() {},
    getAnimations() { return []; },
    // Finishes immediately so exit callbacks run synchronously in tests.
    animate(frames, options) { this.calls.push({ frames, options }); return { cancel() {}, set onfinish(done) { done(); } }; },
    getBoundingClientRect() { return { top: this.parent ? this.parent.children.indexOf(this) * 60 : 0, left: 0, height: this.parent ? 52 : 0 }; },
  };
  n.classList = { add: c => n.classes.add(c), remove: c => n.classes.delete(c), contains: c => n.classes.has(c), toggle: (c, on) => on ? n.classes.add(c) : n.classes.delete(c) };
  return n;
}

function harness() {
  const rail = node('nav'); rail.hidden = true;
  const sent = [];
  const context = {
    rail, sent, saves: 0, page: 'chat',
    unread: new Map([['done', 1]]),
    state: {
      features: { activityRail: true }, activeSessionId: 'run',
      sessions: [{ id: 'run', name: 'Run tests' }, { id: 'ask', name: 'Fix login' }, { id: 'done', name: 'Add rail' }, { id: 'idle', name: 'Old chat' }],
      runStates: { run: { state: 'thinking', label: 'Thinking…' }, ask: { state: 'tool' } },
      timeline: { ask: [{ id: 'approval:1', kind: 'approval', status: 'pending' }] },
    },
    el: id => id === 'rail' ? rail : node(),
    icon: () => node('span'),
    document: { createElement: node, body: node('body') },
    window: {},
    send: message => sent.push(message),
    showPage() {},
    setTimeout: () => 0,
  };
  context.isRunning = id => (context.state.runStates[id]?.state || 'idle') !== 'idle';
  context.saveLocal = () => { context.saves++; };
  vm.createContext(context);
  vm.runInContext(`${railSource}\nthis.renderRail = renderRail; this.openFromRail = openFromRail;`, context);
  const order = () => rail.children.filter(child => child.classes.has('rail-tab')).map(child => [child.dataset.key, [...child.classes].find(c => ['blocked', 'done', 'running'].includes(c))]);
  return { context, rail, sent, order };
}

test('rail lists blocked, then finished, then running chats and skips idle ones', () => {
  const { context, rail, order } = harness();
  context.renderRail();
  assert.equal(rail.hidden, false);
  assert.ok(rail.querySelector('.rail-head'));
  assert.deepEqual(order(), [['ask', 'blocked'], ['done', 'done'], ['run', 'running']]);
  const active = rail.children.find(child => child.dataset.key === 'run');
  assert.ok(active.classes.has('active'));
  assert.match(active.title, /Run tests: Thinking/);
  assert.match(rail.children.find(child => child.dataset.key === 'ask').title, /approval/);
});

test('a chat that finishes springs above running chats and its tab node is reused', () => {
  const { context, rail, order } = harness();
  context.renderRail();
  const tab = rail.children.find(child => child.dataset.key === 'run');
  context.state.runStates.run = { state: 'idle' };
  context.state.activeSessionId = 'other';
  context.unread.set('run', 2);
  context.renderRail();
  assert.deepEqual(order(), [['ask', 'blocked'], ['run', 'done'], ['done', 'done']]);
  assert.equal(rail.children.find(child => child.dataset.key === 'run'), tab);
  assert.ok(tab.animations > 0, 'moved tab slides to its new place');
});

test('opening a finished chat removes it from the rail', () => {
  const { context, sent, order } = harness();
  context.renderRail();
  context.openFromRail('done');
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ type: 'selectSession', sessionId: 'done' }]);
  assert.equal(context.unread.has('done'), false);
  assert.deepEqual(order().map(([id]) => id), ['ask', 'run']);
  assert.ok(context.saves > 0);
});

test('viewing the active chat clears its unread state; answering an approval returns the tab to running', () => {
  const { context, order } = harness();
  context.state.activeSessionId = 'done';
  context.renderRail();
  assert.equal(context.unread.has('done'), false);
  context.state.timeline.ask[0].status = 'allowed';
  context.renderRail();
  assert.deepEqual(order().map(([id, status]) => `${id}:${status}`).sort(), ['ask:running', 'run:running']);
});

const tabOf = (rail, id) => rail.children.find(child => child.dataset.key === id);
const framesOf = tab => tab.calls.map(call => call.frames);

test('tabs present on load spring in from the left one after another', () => {
  const { context, rail } = harness();
  context.renderRail();
  const arrivals = ['ask', 'done', 'run'].map(id => tabOf(rail, id).calls[0]);
  for (const call of arrivals) {
    assert.equal(call.frames[0].translate, '-150% 0');
    assert.equal(call.frames[0].opacity, 0);
    assert.ok(call.frames.some(frame => frame.scale === '1.08'), 'overshoots before settling');
    assert.equal(call.options.fill, 'backwards');
  }
  assert.deepEqual(arrivals.map(call => call.options.delay), [0, 55, 110]);
  context.state.runStates.idle = { state: 'thinking' };
  context.renderRail();
  assert.equal(tabOf(rail, 'idle').calls[0].options.delay, 0, 'later arrivals are not staggered');
});

test('an acknowledged tab flicks off to the left from where it is, then is removed', () => {
  const { context, rail } = harness();
  context.renderRail();
  const tab = tabOf(rail, 'done');
  context.openFromRail('done');
  const exit = tab.calls.at(-1);
  assert.equal(exit.frames.at(-1).translate, '-150% 0');
  assert.equal(exit.frames.at(-1).opacity, 0);
  assert.ok(exit.options.duration <= 350, 'leaves quickly');
  assert.equal(tab.style.position, 'absolute');
  assert.ok(tab.classes.has('leaving'));
  assert.equal(tab.parent, null);
  assert.ok(framesOf(tabOf(rail, 'run')).some(frames => frames[0].translate?.startsWith('0 ')), 'the tab below slides up into the gap');
});

test('a state change pulses the tab and slides it with an additive move', () => {
  const { context, rail } = harness();
  context.renderRail();
  const tab = tabOf(rail, 'run');
  context.state.runStates.run = { state: 'idle' };
  context.state.activeSessionId = 'other';
  context.unread.set('run', 2);
  context.renderRail();
  const pulse = tab.calls.find(call => call.frames[0].boxShadow);
  assert.ok(pulse, 'pulses');
  assert.ok(pulse.frames.some(frame => frame.scale === '1.12'));
  assert.equal(pulse.frames.at(-1).boxShadow, undefined, 'ring fades into the resting look');
  const move = tab.calls.find(call => call.options.composite === 'add');
  assert.ok(move, 'moves with an additive slide so hover and in-flight motion are kept');
  assert.equal(move.frames.at(-1).translate, '0 0');
});

test('an unchanged rail neither moves nor animates anything', () => {
  const { context, rail } = harness();
  context.renderRail();
  const tabs = rail.children.filter(child => child.classes.has('rail-tab'));
  const counts = tabs.map(tab => [tab.moves, tab.calls.length]);
  context.renderRail();
  assert.deepEqual(tabs.map(tab => [tab.moves, tab.calls.length]), counts);
});

test('reduced motion turns every rail animation off', () => {
  const { context, rail } = harness();
  context.document.body.classList.add('reduce-motion');
  context.renderRail();
  context.openFromRail('done');
  assert.equal(rail.children.reduce((sum, child) => sum + child.calls.length, 0), 0);
  assert.equal(rail.calls.length, 0);
});

test('turning the rail off slides it away before hiding', () => {
  const { context, rail } = harness();
  context.renderRail();
  context.state.features.activityRail = false;
  context.renderRail();
  assert.equal(rail.calls.at(-1).frames.at(-1).marginLeft, '-38px');
  assert.equal(rail.hidden, true);
  context.state.features.activityRail = true;
  context.renderRail();
  assert.equal(rail.hidden, false);
  assert.equal(rail.calls.at(-1).frames[0].marginLeft, '-38px', 'slides back in');
});

test('turning the rail off hides it', () => {
  const { context, rail } = harness();
  context.renderRail();
  context.state.features.activityRail = false;
  context.renderRail();
  assert.equal(rail.hidden, true);
});

test('sidebar markup has the rail, settings menu and Customize page', () => {
  const html = getSidebarHtml({ cspSource: 'vscode-webview://test' }, initialSidebarState());
  assert.match(html, /<nav id="rail" class="rail"/);
  assert.match(html, /<div class="chat-column">/);
  assert.match(html, /id="settings-toggle"/);
  assert.match(html, /id="customize-page"/);
  assert.equal(initialSidebarState().features.activityRail, true);
  assert.match(source, /key: 'activityRail'/);
});
