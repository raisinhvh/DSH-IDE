import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptPrefix, skipToolListChanged } from '../dist/runtime/promptPrefix.mjs';

test('resumed Claude sessions keep the original system and send changes once', () => {
  assert.deepEqual(promptPrefix('new', false, 'old', 'old'), { system: 'new', last: 'new', note: '' });
  const changed = promptPrefix('new', true, 'old', 'old');
  assert.deepEqual(changed, { system: 'old', last: 'new', note: '[DSH: your instructions changed]\nnew' });
  assert.equal(promptPrefix('new', true, 'old', changed.last).note, '');
  assert.match(promptPrefix('old', true, 'old', 'new').note, /instructions changed/);
});

test('tool list changes are suppressed only for Claude with an init list lacking ToolSearch', () => {
  assert.equal(skipToolListChanged('claude-cli', ['Read']), true);
  assert.equal(skipToolListChanged('claude-cli', ['Read', 'ToolSearch']), false);
  assert.equal(skipToolListChanged('claude-cli'), false);
  assert.equal(skipToolListChanged('codex-cli', ['Read']), false);
});
