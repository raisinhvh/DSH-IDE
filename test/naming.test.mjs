import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { chatTitlePrompt, cleanChatTitle, firstMessageTitle, MAX_TITLE_LENGTH } from '../dist/runtime/naming.mjs';

test('first-message titles collapse whitespace and fall back for image-only prompts', () => {
  assert.equal(firstMessageTitle('  fix   the\nsidebar  '), 'fix the sidebar');
  assert.equal(firstMessageTitle('   '), 'Image');
  assert.equal(firstMessageTitle('x'.repeat(80)).length, 48);
});

test('the title prompt carries the request and asks for a bare title', () => {
  const prompt = chatTitlePrompt('  make the tabs vertical  ');
  assert.match(prompt, /ONLY the title/);
  assert.match(prompt, /Request:\nmake the tabs vertical$/);
  assert.ok(chatTitlePrompt('y'.repeat(9000)).length < 4500);
});

test('cleans model replies into a short title', () => {
  assert.equal(cleanChatTitle('Fix sidebar tab overflow'), 'Fix sidebar tab overflow');
  assert.equal(cleanChatTitle('"Fix sidebar tab overflow."'), 'Fix sidebar tab overflow');
  assert.equal(cleanChatTitle('\n\nTitle: Add settings dropdown\nBecause the top bar is crowded.'), 'Add settings dropdown');
  assert.equal(cleanChatTitle('**Share rules with Claude**'), 'Share rules with Claude');
  assert.equal(cleanChatTitle('# Activity rail design'), 'Activity rail design');
  assert.equal(cleanChatTitle('“Sync skills across machines”'), 'Sync skills across machines');
  assert.equal(cleanChatTitle('  \n  '), undefined);
  assert.equal(cleanChatTitle('"..."'), undefined);
  const long = cleanChatTitle('word '.repeat(40));
  assert.equal(long.length, MAX_TITLE_LENGTH);
  assert.ok(long.endsWith('…'));
});
