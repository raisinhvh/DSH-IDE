import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { compareVersions } from '../dist/update/version.mjs';

test('compares DSH versions with semver prerelease ordering', () => {
  const ascending = ['0.1.7-alpha.2', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0-rc.10', '0.2.0', '0.2.1', '0.10.0', '1.0.0'];
  for (let i = 0; i < ascending.length; i++) {
    assert.equal(compareVersions(ascending[i], ascending[i]), 0);
    for (let j = i + 1; j < ascending.length; j++) {
      assert.equal(compareVersions(ascending[i], ascending[j]), -1, `${ascending[i]} < ${ascending[j]}`);
      assert.equal(compareVersions(ascending[j], ascending[i]), 1, `${ascending[j]} > ${ascending[i]}`);
    }
  }
});
