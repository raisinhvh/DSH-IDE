import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { checkpointHandoff, parseCheckpoint } from '../dist/runtime/checkpoint.mjs';

test('checkpoint validates required text and retains file names', () => {
  assert.throws(() => parseCheckpoint({ summary: 'x' }), /reason/);
  assert.throws(() => parseCheckpoint({ summary: 'x', reason: 'done', keep_files: [1] }), /keep_files/);
  const checkpoint = parseCheckpoint({ summary: 'Goal and decisions', reason: 'done', keep_files: ['src/a.ts'] });
  const history = Array.from({ length: 4 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `message ${index}` }));
  const text = checkpointHandoff(history, checkpoint, true);
  assert.match(text, /Goal and decisions/);
  assert.match(text, /Files to re-read if needed: src\/a.ts/);
  assert.match(text, /User: message 2\n\nAssistant: message 3/);
  assert.match(text, /read_chat_history/);
});
