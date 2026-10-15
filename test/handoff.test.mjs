import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildHandoff, chatHistoryReply, handoffSummaryPrompt } from '../dist/runtime/handoff.mjs';

const history = Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `message ${index + 1}` }));

test('a summarized handoff keeps only the latest exchange and points to the history tool', () => {
  const text = buildHandoff(history, 'They want X.', true);
  assert.match(text, /Summary of the 6 earlier messages:\nThey want X\./);
  assert.match(text, /Latest messages, word for word:\nUser: message 7\n\nAssistant: message 8/);
  assert.doesNotMatch(text, /message 6/);
  assert.match(text, /read_chat_history/);
});

test('without a summary or the tool, the last six messages are kept', () => {
  for (const text of [buildHandoff(history, undefined, true), buildHandoff(history, 'They want X.', false)]) {
    assert.match(text, /\(2 earlier messages are not shown\.\)|Summary of the 2 earlier messages/);
    assert.match(text, /User: message 3/);
    assert.doesNotMatch(text, /message 2\b/);
  }
  assert.doesNotMatch(buildHandoff(history, undefined, false), /read_chat_history/);
  assert.equal(buildHandoff([], 'x', true), '');
  assert.doesNotMatch(buildHandoff(history.slice(0, 2), 'x', true), /Summary|read_chat_history/);
});

test('history replies return the most recent messages in order', () => {
  assert.equal(chatHistoryReply(history, 2), '(6 earlier messages not shown.)\n\nUser: message 7\n\nAssistant: message 8');
  assert.match(chatHistoryReply(history, 100), /^User: message 1/);
  assert.equal(chatHistoryReply([], 5), 'There are no earlier messages.');
  assert.match(handoffSummaryPrompt(history), /User: message 1\n\nAssistant: message 2/);
});
