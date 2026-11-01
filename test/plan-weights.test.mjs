import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: ['src/accounts/planPrices.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { chatGptPlan, claudePlan, cursorPlan } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('plan prices come from each provider\'s plan identifiers', () => {
  assert.deepEqual(chatGptPlan('plus'), { name: 'Plus', monthlyUsd: 20 });
  assert.deepEqual(chatGptPlan('PRO'), { name: 'Pro', monthlyUsd: 200 });
  assert.equal(chatGptPlan('enterprise'), undefined);
  assert.deepEqual(claudePlan('pro', 'default_claude_ai'), { name: 'Pro', monthlyUsd: 20 });
  assert.deepEqual(claudePlan('max', 'default_claude_max_20x'), { name: 'Max 20x', monthlyUsd: 200 });
  assert.deepEqual(claudePlan('max', 'default_claude_max_5x'), { name: 'Max 5x', monthlyUsd: 100 });
  assert.deepEqual(cursorPlan('Pro+', '$60/mo'), { name: 'Pro+', monthlyUsd: 60 });
  assert.equal(cursorPlan('Pro', 'Custom'), undefined);
});
