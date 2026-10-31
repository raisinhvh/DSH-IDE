import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { build } from 'esbuild';

async function load(entry) {
  const bundled = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'vscode-stub', setup(builder) {
      builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const workspace = {};' }));
    } }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
}

const { AccountUsageService } = await load('src/accounts/usageService.ts');
const { AccountRegistry } = await load('src/accounts/accountRegistry.ts');

test('usage service retries one transient failure and replaces stale fix on success', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? new Response('', { status: 500 }) : Response.json({ data: { usage: 1 } });
  try {
    const service = new AccountUsageService(() => {});
    await service.refreshOne({ id: 'id', provider: 'openrouter', secret: async () => 'key' });
    assert.equal(calls, 2);
    assert.equal(service.snapshot().id.status, 'ready');
    assert.equal(service.snapshot().id.fix, undefined);
  } finally { globalThis.fetch = original; }
});

test('account registry replaces a trimmed secret and rejects missing accounts and empty keys', async () => {
  const state = new Map(); const secrets = new Map();
  const registry = new AccountRegistry({ globalState: { get: (key, fallback) => state.get(key) ?? fallback, update: async (key, value) => state.set(key, value) },
    secrets: { get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value) } });
  const account = await registry.add({ provider: 'openrouter', label: 'Test', secret: 'old' });
  await assert.rejects(registry.replaceSecret('missing', 'key'), /Account not found\./);
  await assert.rejects(registry.replaceSecret(account.id, '  '), /Account secret is required/);
  assert.equal(await registry.getSecret(account.id), 'old');
  await registry.replaceSecret(account.id, '  new-key  ');
  assert.equal(await registry.getSecret(account.id), 'new-key');
});
