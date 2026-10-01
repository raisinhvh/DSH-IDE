import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bundle = await build({ entryPoints: ['src/runtime/dependencies.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { WindowsDependencies } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('Windows setup reuses a compatible explicit Node and npm without downloading', { skip: process.platform !== 'win32' }, async () => {
  const manager = new WindowsDependencies(tmpdir(), () => process.execPath);
  assert.equal(await manager.ensureNode(), process.execPath);
});

test('Windows setup rejects a bad custom Node path without replacing it', { skip: process.platform !== 'win32' }, async () => {
  const manager = new WindowsDependencies(tmpdir(), () => join(tmpdir(), 'missing-dsh-node.exe'));
  await assert.rejects(manager.ensureNode(), /Configured Node executable/);
});

test('Node bootstrap deduplicates downloads, rejects corrupt archives, cleans up, and retries', { skip: process.platform !== 'win32' }, async () => {
  const storage = await mkdtemp(join(tmpdir(), 'dsh-dependency-test-'));
  const originalFetch = globalThis.fetch;
  let releaseRequests = 0;
  globalThis.fetch = async url => {
    if (String(url).endsWith('index.json')) {
      releaseRequests++;
      return Response.json([{ version: 'v24.10.0', lts: 'Krypton' }]);
    }
    if (String(url).endsWith('SHASUMS256.txt')) return new Response(`${'0'.repeat(64)}  node-v24.10.0-win-${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip\n`);
    return new Response('corrupt archive');
  };
  try {
    const manager = new WindowsDependencies(storage);
    // Simulate a fresh device: every existing runtime probe fails.
    manager.probeNode = async () => false;
    const first = manager.ensureNode();
    assert.equal(manager.ensureNode(), first);
    await assert.rejects(first, /SHA-256 verification failed/);
    assert.equal(releaseRequests, 1);
    assert.equal((await readdir(storage)).some(name => name.startsWith('node-stage-')), false);
    await assert.rejects(manager.ensureNode(), /SHA-256 verification failed/);
    assert.equal(releaseRequests, 2);
    await assert.rejects(manager.installProvider('untrusted-provider'), /Unsupported provider/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(storage, { recursive: true, force: true });
  }
});
