import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { accessibilityStyle, defaultAccessibility, getSidebarHtml, initialSidebarState, normalizeAccessibility } from '../dist/sidebar/view.mjs';

const script = readFileSync(new URL('../media/sidebar.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../media/sidebar.css', import.meta.url), 'utf8');

test('stored accessibility values are clamped and unknown values fall back to defaults', () => {
  assert.deepEqual(normalizeAccessibility(undefined), defaultAccessibility());
  assert.deepEqual(normalizeAccessibility('junk'), defaultAccessibility());
  const value = normalizeAccessibility({ textScale: 9, lineSpacing: 'loose', spacing: 'huge', letterSpacing: 'wide', highContrast: 'yes', largeTargets: true, underlineLinks: true, extra: 1 });
  assert.deepEqual(value, { textScale: 1.6, lineSpacing: 'loose', spacing: 'default', letterSpacing: 'wide', highContrast: false, largeTargets: true, underlineLinks: true });
  assert.equal(normalizeAccessibility({ textScale: 0.1 }).textScale, 0.85);
  assert.equal(normalizeAccessibility({ textScale: 1.234 }).textScale, 1.23);
  assert.equal(normalizeAccessibility({ lineSpacing: 'toString' }).lineSpacing, 'normal', 'inherited keys are not options');
});

test('preferences map to CSS variables and body classes', () => {
  const style = accessibilityStyle({ ...defaultAccessibility(), textScale: 1.25, lineSpacing: 'relaxed', spacing: 'roomy', letterSpacing: 'wide', highContrast: true, underlineLinks: true });
  assert.deepEqual(style.vars, { '--text-scale': '1.25', '--line-scale': '1.2', '--space-scale': '1.35', '--letter-spacing': '0.04em' });
  assert.deepEqual(style.classes, ['a11y-contrast', 'a11y-underline']);
});

test('the first paint already uses saved preferences, inside the nonce-protected style block', () => {
  const state = initialSidebarState();
  state.accessibility = { ...defaultAccessibility(), textScale: 1.3, largeTargets: true };
  state.features.reduceMotion = true;
  const html = getSidebarHtml({ cspSource: 'vscode-webview://test' }, state);
  assert.match(html, /<style nonce="[^"]+">[^<]*:root\{--text-scale:1\.3;--line-scale:1;--space-scale:1;--letter-spacing:normal\}<\/style>/);
  assert.match(html, /<body class="a11y-targets reduce-motion">/);
  assert.doesNotMatch(html, /\sstyle="/, 'no inline style attributes, which the CSP would block');
  assert.match(html, /id="accessibility-page"/);
  assert.match(html, /id="accessibility" type="button" role="menuitem"/);
});

test('every font size in the stylesheet follows the text size setting', () => {
  assert.equal((css.match(/font(-size)?:\s*[\d.]+px/g) || []).length, 0);
  assert.ok((css.match(/var\(--text-scale, 1\)/g) || []).length > 100);
  assert.match(css, /\.bubble \{[^}]*line-height: calc\(1\.45 \* var\(--line-scale, 1\)\)/);
  assert.match(css, /body \{[^}]*letter-spacing: var\(--letter-spacing, normal\)/);
  for (const name of ['a11y-contrast', 'a11y-targets', 'a11y-underline']) assert.match(css, new RegExp(`body\\.${name}`));
  assert.doesNotMatch(script, /\{ key: 'reduceMotion', icon:/, 'reduce motion moved off the Customize list');
  assert.match(script, /type: 'setFeature', key: 'reduceMotion'/, 'the Accessibility page toggles it');
  assert.match(script, /type: 'saveAccessibility'/);
});

function deleteAllHarness(runStates) {
  const node = () => ({
    children: [], className: '', textContent: '', disabled: false, title: '', isConnected: true,
    classes: new Set(), classList: null,
    append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); },
  });
  const make = () => { const n = node(); n.classList = { toggle: (c, on) => on ? n.classes.add(c) : n.classes.delete(c) }; return n; };
  const sent = [];
  const menu = make(); menu.hidden = false;
  const context = {
    sent, Date, setTimeout: () => 0,
    state: { sessions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    isRunning: id => !!runStates[id],
    send: message => sent.push(JSON.parse(JSON.stringify(message))),
    icon: name => { const n = make(); n.textContent = name; return n; },
    button: (_label, title, action, className) => { const n = make(); n.title = title; n.onclick = action; n.className = className; return n; },
    el: id => id === 'recent-menu' ? menu : { setAttribute() {} },
    document: { createElement: make, createTextNode: text => ({ textContent: text }) },
  };
  vm.createContext(context);
  const slice = script.slice(script.indexOf('  let deleteAllArmed = 0;'), script.indexOf('  function renderTabs(root) {'));
  vm.runInContext(`${slice}\nthis.deleteAllRow = deleteAllRow;`, context);
  return { context, sent, menu };
}

test('Delete all needs a second click, skips running chats and says so', () => {
  const { context, sent, menu } = deleteAllHarness({ b: true });
  const action = context.deleteAllRow().children[0];
  const label = () => action.children[1].textContent;
  assert.equal(label(), 'Delete all');
  assert.match(action.title, /Delete 2 chats.*1 running chat is kept/);
  action.onclick();
  assert.equal(sent.length, 0, 'first click only arms');
  assert.equal(label(), 'Click again to delete 2 chats');
  assert.ok(action.classes.has('confirming'));
  action.onclick();
  assert.deepEqual(sent, [{ type: 'deleteAllSessions' }]);
  assert.equal(menu.hidden, true);
});

test('Delete all is disabled when only running chats remain', () => {
  const { context } = deleteAllHarness({ a: true, b: true, c: true });
  const action = context.deleteAllRow().children[0];
  assert.equal(action.disabled, true);
  assert.match(action.title, /cancel them/);
});
