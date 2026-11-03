import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withExplorer } from '../dist/runtime/explorer.mjs';
import { delegationInstructions } from '../dist/runtime/delegation.mjs';

test('explorer is opt-in and user profiles take precedence', () => {
  const profiles = [{ name: 'other' }];
  assert.deepEqual(withExplorer(profiles, {}), profiles);
  const result = withExplorer(profiles, { model: 'small', effort: 'low', speed: 'Fast' });
  assert.deepEqual(result[1], { name: 'explorer', description: 'Searches and reads files and returns a concise answer.', model: 'small', effort: 'low', speed: 'Fast', mode: 'read-only' });
  const custom = [{ name: 'explorer', model: 'custom' }];
  assert.deepEqual(withExplorer(custom, { model: 'small' }), custom);
});

test('explorer instructions are opt-in', () => {
  assert.equal(delegationInstructions(true), delegationInstructions(true, { explorer: false }));
  assert.equal(delegationInstructions(false), delegationInstructions(false, { explorer: true }));
  assert.match(delegationInstructions(true, { explorer: true }), /delegate to explorer/);
});
