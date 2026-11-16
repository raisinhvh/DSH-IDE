import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { SELF_HOSTED, SELF_HOSTED_ENV, normalizeBaseURL, parseModelIds } from '../dist/runtime/selfHosted.mjs';

test('constants', () => {
  assert.equal(SELF_HOSTED, 'self-hosted');
  assert.equal(SELF_HOSTED_ENV, 'SELF_HOSTED_API_KEY');
});

test('normalizeBaseURL accepts and cleans valid URLs', () => {
  assert.equal(normalizeBaseURL(' https://gw.example.com/v1/ '), 'https://gw.example.com/v1');
  assert.equal(normalizeBaseURL('https://gw.example.com/v1//'), 'https://gw.example.com/v1');
  assert.equal(normalizeBaseURL('https://gw.example.com/v1?x=1#frag'), 'https://gw.example.com/v1');
  assert.equal(normalizeBaseURL('http://localhost:8787/v1'), 'http://localhost:8787/v1');
  assert.equal(normalizeBaseURL('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(normalizeBaseURL('http://192.168.1.5:8000/v1'), 'http://192.168.1.5:8000/v1');
  assert.equal(normalizeBaseURL('http://10.0.0.2/v1'), 'http://10.0.0.2/v1');
  assert.equal(normalizeBaseURL('http://172.20.1.1/v1'), 'http://172.20.1.1/v1');
  assert.equal(normalizeBaseURL('http://box.local/v1'), 'http://box.local/v1');
  assert.equal(normalizeBaseURL('http://[::1]:8000/v1'), 'http://[::1]:8000/v1');
});

test('normalizeBaseURL rejects unsafe or invalid input', () => {
  assert.throws(() => normalizeBaseURL('http://example.com/v1'), /https/);
  assert.throws(() => normalizeBaseURL('http://172.32.0.1/v1'), /https/);
  assert.throws(() => normalizeBaseURL('ftp://example.com/v1'), /http/);
  assert.throws(() => normalizeBaseURL('not a url'), /valid URL/);
  assert.throws(() => normalizeBaseURL('   '), /base URL/);
});

test('parseModelIds returns sorted unique ids', () => {
  assert.deepEqual(parseModelIds({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }, { nope: 1 }] }), ['a', 'b']);
  assert.deepEqual(parseModelIds({ data: [] }), []);
  assert.throws(() => parseModelIds({}), /model list/);
  assert.throws(() => parseModelIds(null), /model list/);
  assert.throws(() => parseModelIds([]), /model list/);
});
