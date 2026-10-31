import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { build } from 'esbuild';

let launch;
let rpcError;
globalThis.__dshCodexUsageSpawn = (command, args, options) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.kill = () => {
    if (child.killed) return false;
    child.killed = true;
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  };
  launch = { command, args, options, child, requests: [] };
  let buffer = '';
  child.stdin.on('data', chunk => {
    buffer += String(chunk);
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      launch.requests.push(request);
      if (request.id === undefined) continue;
      if (request.method === 'account/rateLimits/read' && rpcError) {
        queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, error: { message: rpcError } }) + '\n'));
        continue;
      }
      const result = request.method === 'account/rateLimits/read' ? {
        rateLimitsByLimitId: {
          codex: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1730947200 }, secondary: { usedPercent: 70, windowDurationMins: 10080 } },
          extra: { limitName: 'Extra', primary: { usedPercent: 12, windowDurationMins: 60, resetsAt: 1730948000 }, secondary: null },
          missing: { primary: null, secondary: { usedPercent: null } },
        },
      } : {};
      queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n'));
    }
  });
  return child;
};

const bundled = await build({
  entryPoints: ['src/accounts/codexUsage.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'fake-app-server', setup(builder) {
    builder.onResolve({ filter: /^node:child_process$/ }, () => ({ path: 'process', namespace: 'fake' }));
    builder.onResolve({ filter: /oauthCli$/ }, () => ({ path: 'oauth', namespace: 'fake' }));
    builder.onLoad({ filter: /.*/, namespace: 'fake' }, ({ path }) => ({ contents: path === 'process'
      ? 'export const spawn = (...args) => globalThis.__dshCodexUsageSpawn(...args);'
      : 'export const cliCommand = () => "codex"; export const cliEnv = account => ({ CODEX_HOME: account.directory });' }));
  } }],
});
const { readCodexUsage } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('Codex usage calls documented app-server RPC and maps returned quota windows', async () => {
  const usage = await readCodexUsage({ id: 'codex:test', provider: 'codex-cli', label: 'Test', directory: 'isolated-profile' });
  assert.equal(launch.command, 'codex');
  assert.deepEqual(launch.args, ['app-server', '--listen', 'stdio://']);
  assert.equal(launch.options.env.CODEX_HOME, 'isolated-profile');
  assert.deepEqual(launch.requests.map(request => request.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.equal(usage.status, 'ready');
  assert.equal(usage.metrics.length, 3);
  assert.deepEqual(usage.metrics.map(metric => metric.label), ['5-hour', 'Weekly', 'Extra \u00b7 1h']);
  assert.equal(usage.metrics[0].usedPercent, 25);
  assert.equal(usage.metrics[0].resetsAt, 1730947200000);
  assert.equal(usage.metrics[1].resetsAt, undefined);
  assert.equal(launch.child.killed, true);
});

test('Codex usage rejects non-Codex profiles without launching a process', async () => {
  const before = launch;
  const usage = await readCodexUsage({ id: 'other', provider: 'claude-cli', label: 'Other', directory: 'profile' });
  assert.equal(usage.status, 'unavailable');
  assert.equal(launch, before);
});

test('Codex RPC errors distinguish sign-in from transient failures', async () => {
  const account = { id: 'codex:test', provider: 'codex-cli', label: 'Test', directory: 'profile' };
  try {
    rpcError = '401 token expired';
    const auth = await readCodexUsage(account);
    assert.equal(auth.fix, 'signin');
    assert.equal(auth.detail, 'Codex sign-in has expired. Sign in again to see usage.');
    rpcError = 'backend is busy';
    const generic = await readCodexUsage(account);
    assert.equal(generic.fix, 'retry');
    assert.equal(generic.detail, 'Could not read Codex usage. Try again.');
  } finally { rpcError = undefined; }
});
