import test from 'node:test';
import assert from 'node:assert/strict';
import { readCursorUsage } from '../out/accounts/cursorUsage.js';

test('Cursor subscription usage is explicitly unavailable without CLI or network access', async () => {
  const usage = await readCursorUsage();

  assert.equal(usage.status, 'unavailable');
  assert.deepEqual(usage.metrics, []);
  assert.match(usage.detail, /documented personal CLI or ACP interface/);
  assert.equal(typeof usage.fetchedAt, 'number');
});
