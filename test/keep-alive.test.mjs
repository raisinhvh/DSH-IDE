import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { shouldKeepAlive } from '../dist/runtime/keepAlive.mjs';

test('keep alive requires every idle and cache condition', () => {
  const ready = { now: 4_000_000, lastTurnAt: 1_000_000, contextTokens: 80000, hint: 80000, pingsSent: 0, max: 3, shortCache: false, running: false, visible: true };
  assert.equal(shouldKeepAlive(ready), true);
  for (const change of [{ lastTurnAt: 1_000_001 }, { contextTokens: 79999 }, { pingsSent: 3 }, { shortCache: true }, { running: true }, { visible: false }, { max: 0 }]) {
    assert.equal(shouldKeepAlive({ ...ready, ...change }), false);
  }
});
