import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({
  entryPoints: ['src/accounts/deepseekUsage.ts'], bundle: true, write: false,
  format: 'esm', platform: 'node', target: 'node20',
});
const { readDeepSeekUsage } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

function withFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve().then(run).finally(() => { globalThis.fetch = original; });
}

test('DeepSeek usage maps balances with explicit currencies and honest detail', async () => {
  let request;
  const usage = await withFetch(async (url, options) => {
    request = { url, options };
    return Response.json({ is_available: true, balance_infos: [
      { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
      { currency: 'USD', total_balance: '2.5', granted_balance: '0', topped_up_balance: '2.5' },
    ] });
  }, () => readDeepSeekUsage('secret-test-key'));

  assert.equal(request.url, 'https://api.deepseek.com/user/balance');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers.Authorization, 'Bearer secret-test-key');
  assert.equal(request.options.redirect, 'error');
  assert.equal(usage.status, 'ready');
  assert.deepEqual(usage.metrics.map(metric => metric.value), [
    '110.00 CNY', '10.00 CNY', '100.00 CNY', '2.5 USD', '0 USD', '2.5 USD',
  ]);
  assert.match(usage.detail, /balance, not 5h, weekly, or monthly used quota/);
  assert.equal(typeof usage.fetchedAt, 'number');
});

test('DeepSeek unavailable and empty balance responses are represented without inventing quota', async () => {
  const low = await withFetch(async () => Response.json({ is_available: false, balance_infos: [
    { currency: 'USD', total_balance: '0', granted_balance: '0', topped_up_balance: '0' },
  ] }), () => readDeepSeekUsage('key'));
  assert.equal(low.status, 'unavailable');
  assert.equal(low.metrics[0].value, '0 USD');

  const empty = await withFetch(async () => Response.json({ is_available: true, balance_infos: [] }), () => readDeepSeekUsage('key'));
  assert.equal(empty.status, 'unavailable');
  assert.deepEqual(empty.metrics, []);
});

test('DeepSeek rejects malformed schema, unsupported currency, and unsafe monetary values', async () => {
  for (const body of [
    { is_available: 'yes', balance_infos: [] },
    { is_available: true, balance_infos: [{ currency: 'EUR', total_balance: '1', granted_balance: '0', topped_up_balance: '1' }] },
    { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '1e9', granted_balance: '0', topped_up_balance: '1' }] },
    { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1', granted_balance: '0', topped_up_balance: '1' }, { currency: 'CNY', total_balance: '1', granted_balance: '0', topped_up_balance: '1' }] },
  ]) {
    const usage = await withFetch(async () => Response.json(body), () => readDeepSeekUsage('key'));
    assert.equal(usage.status, 'error');
    assert.deepEqual(usage.metrics, []);
  }
});

test('DeepSeek errors do not expose provider body or API key', async () => {
  const key = 'very-secret-api-key';
  const usage = await withFetch(async () => new Response(key + ' provider internal detail', { status: 401 }), () => readDeepSeekUsage(key));
  assert.equal(usage.status, 'error');
  assert.doesNotMatch(JSON.stringify(usage), /very-secret-api-key|provider internal detail/);
});

test('DeepSeek invalid JSON and oversized responses fail safely', async () => {
  const invalid = await withFetch(async () => new Response('{not json'), () => readDeepSeekUsage('key'));
  assert.equal(invalid.status, 'error');
  const oversized = await withFetch(async () => new Response(' '.repeat(33 * 1024)), () => readDeepSeekUsage('key'));
  assert.equal(oversized.status, 'error');
});
