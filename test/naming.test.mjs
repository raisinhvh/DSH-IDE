import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CHAT_ICONS, chatTitlePrompt, cleanChatTitle, firstMessageTitle, MAX_TITLE_LENGTH, parseChatName } from '../dist/runtime/naming.mjs';

test('first-message titles collapse whitespace and fall back for image-only prompts', () => {
  assert.equal(firstMessageTitle('  fix   the\nsidebar  '), 'fix the sidebar');
  assert.equal(firstMessageTitle('   '), 'Image');
  assert.equal(firstMessageTitle('x'.repeat(80)).length, 48);
});

test('the title prompt carries the request and asks for an icon and a one to three word title', () => {
  const prompt = chatTitlePrompt('  make the tabs vertical  ');
  assert.match(prompt, /"icon \| Title"/);
  assert.match(prompt, /ONE word is best/);
  assert.match(prompt, /three words is the hard maximum/);
  assert.match(prompt, /Request:\nmake the tabs vertical$/);
  assert.ok(chatTitlePrompt('y'.repeat(9000)).length < chatTitlePrompt('').length + 4100);
});

test('cleans model replies into a title of at most three words', () => {
  assert.equal(cleanChatTitle('Tab overflow'), 'Tab overflow');
  assert.equal(cleanChatTitle('Fix sidebar tab overflow'), 'Fix sidebar tab');
  assert.equal(cleanChatTitle('"Diff viewer."'), 'Diff viewer');
  assert.equal(cleanChatTitle('\n\nTitle: Settings dropdown\nBecause the top bar is crowded.'), 'Settings dropdown');
  assert.equal(cleanChatTitle('**Shared rules**'), 'Shared rules');
  assert.equal(cleanChatTitle('# Activity rail'), 'Activity rail');
  assert.equal(cleanChatTitle('“Skill sync”'), 'Skill sync');
  assert.equal(cleanChatTitle('  \n  '), undefined);
  assert.equal(cleanChatTitle('"..."'), undefined);
  const long = cleanChatTitle('x'.repeat(80));
  assert.equal(long.length, MAX_TITLE_LENGTH);
  assert.ok(long.endsWith('…'));
});

test('reads the rail icon only when it is a listed symbol', () => {
  assert.deepEqual(parseChatName('bug_report | Login bug'), { title: 'Login bug', icon: 'bug_report' });
  assert.deepEqual(parseChatName('`palette` | Theme colors'), { title: 'Theme colors', icon: 'palette' });
  assert.deepEqual(parseChatName('not_an_icon | Login bug'), { title: 'Login bug', icon: undefined });
  assert.deepEqual(parseChatName('Rail icons'), { title: 'Rail icons', icon: undefined });
  assert.equal(new Set(CHAT_ICONS).size, CHAT_ICONS.length);
});
