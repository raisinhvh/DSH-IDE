import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { planUpdates } from '../dist/update/plan.mjs';

const extension = { version: '0.5.0', downloadUrl: 'https://github.com/raisinhvh/DSH-IDE/releases/download/v0.5.0/dsh-ide-0.5.0.vsix' };
const dsh = { current: '0.2.0-rc.2', latest: '0.2.0' };

test('a DSH update with a newer plugin release forces the plugin update', () => {
  for (const options of [{ promptOptional: true }, { promptOptional: false }, { promptOptional: false, skippedDsh: dsh.latest }]) {
    assert.deepEqual(planUpdates({ extension, dsh }, options), { required: true, extension, dsh });
  }
});

test('a DSH update without a plugin release stays optional and honors skip', () => {
  assert.deepEqual(planUpdates({ dsh }, { promptOptional: true }), { required: false, dsh });
  assert.equal(planUpdates({ dsh }, { promptOptional: true, skippedDsh: dsh.latest }), undefined);
  assert.equal(planUpdates({ dsh }, { promptOptional: false }), undefined);
});

test('a plugin-only update is optional', () => {
  assert.deepEqual(planUpdates({ extension }, { promptOptional: true }), { required: false, extension });
  assert.equal(planUpdates({ extension }, { promptOptional: false }), undefined);
  assert.equal(planUpdates({}, { promptOptional: true }), undefined);
});
