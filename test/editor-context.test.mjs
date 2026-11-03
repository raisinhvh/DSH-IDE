import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorContextDiff } from '../dist/runtime/editorContext.mjs';

const first = 'IDE context\nActive file: a.ts\nCursor: line 1, column 1\nDiagnostics: none';
const moved = first.replace('line 1', 'line 2');
test('editor context sends only changes and resets with a new session', () => {
  assert.equal(editorContextDiff(first, first), '');
  assert.equal(editorContextDiff(first, moved), 'Cursor: line 2, column 1');
  assert.equal(editorContextDiff(undefined, moved), moved);
});
