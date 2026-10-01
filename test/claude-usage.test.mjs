import test from 'node:test';
import assert from 'node:assert/strict';
import { readClaudeUsage } from '../out/accounts/claudeUsage.js';

test('Claude subscription usage is explicitly unavailable without CLI or network access', async () => {
  const usage = await readClaudeUsage({
    id: 'claude:test', provider: 'claude-cli', label: 'Claude', directory: 'unused',
  });

  assert.equal(usage.status, 'unavailable');
  assert.deepEqual(usage.metrics, []);
  assert.match(usage.detail, /documented programmatic interface/);
  assert.equal(typeof usage.fetchedAt, 'number');
});

test('Claude usage adapter rejects non-Claude accounts with an explicit explanation', async () => {
  const usage = await readClaudeUsage({
    id: 'codex:test', provider: 'codex-cli', label: 'Codex', directory: 'unused',
  });

  assert.equal(usage.status, 'unavailable');
  assert.deepEqual(usage.metrics, []);
  assert.equal(usage.detail, 'Usage is available only for Claude accounts.');
});
