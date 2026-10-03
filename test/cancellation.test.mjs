import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const bundle = await build({
  stdin: { contents: `export { AcpRuntime } from './runtime/acp';
    export { CodexAppServerRuntime } from './runtime/codexAppServer';
    export { OAuthCliRuntime } from './runtime/oauthCli';
    export { terminateProcessTree } from './runtime/cancellation';
    export { WorkspaceMirror } from './runtime/shadow';`, resolveDir: resolve('src'), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'runtime-stubs', setup(builder) {
    builder.onResolve({ filter: /^node:child_process$/ }, () => ({ path: 'spawn', namespace: 'stub' }));
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
    builder.onResolve({ filter: /accounts\/oauthCli$/ }, () => ({ path: 'account', namespace: 'stub' }));
    builder.onResolve({ filter: /\/dshUpdate$/ }, () => ({ path: 'update', namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: {
      spawn: 'export const spawn = (...args) => globalThis.__dshCancellationSpawn(...args);',
      account: 'export const cliCommand = provider => provider; export const cliEnv = () => ({});',
      update: 'export const dshBinFrom = () => "dsh";',
      vscode: `import { EventEmitter as Emitter } from 'node:events';
        export const workspace = {};
        export const Uri = { file: path => ({ fsPath: path }) };
        export class RelativePattern {}
        export class EventEmitter {
          emitter = new Emitter();
          event = listener => { this.emitter.on('event', listener); return { dispose() {} }; };
          fire(value) { this.emitter.emit('event', value); }
          dispose() { this.emitter.removeAllListeners(); }
        }`,
    }[args.path] }));
  } }],
});
const { AcpRuntime, CodexAppServerRuntime, OAuthCliRuntime, WorkspaceMirror, terminateProcessTree } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function fakeChild(respond = () => undefined) {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, killed: false, kill() { this.killed = true; }, unref() {} });
  child.message = frame => child.stdout.write(JSON.stringify(frame) + '\n');
  child.frames = [];
  child.stdin.on('data', chunk => {
    for (const line of chunk.toString().trim().split('\n')) {
      const frame = JSON.parse(line);
      child.frames.push(frame);
      const result = frame.method === 'windowsSandbox/readiness' ? { status: 'ready' } : respond(frame);
      if (result !== undefined) queueMicrotask(() => { if (!child.stdout.destroyed) child.message({ id: frame.id, result }); });
    }
  });
  return child;
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const turn = provider => ({ account: { provider }, cwd: '.', backend: 'default', prompt: 'hello', onText() {}, onTool() {} });

test('Windows cancellation kills the process tree once, including descendants', { skip: process.platform !== 'win32' }, () => {
  const child = fakeChild();
  child.pid = 12345;
  const calls = [];
  globalThis.__dshCancellationSpawn = (...args) => { calls.push(args); return fakeChild(); };
  terminateProcessTree(child);
  terminateProcessTree(child);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'taskkill');
  assert.deepEqual(calls[0][1], ['/pid', '12345', '/T', '/F']);
  assert.equal(calls[0][2].windowsHide, true);
  assert.equal(child.stdout.destroyed, true);
});

for (const acknowledge of [false, true]) {
  test(`Codex cancellation finishes even when interrupt ${acknowledge ? 'is acknowledged without completion' : 'never responds'}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild(frame => ({ initialize: {}, 'thread/start': { thread: { id: 'thread' } },
      'turn/start': { turn: { id: 'turn' } }, ...(acknowledge ? { 'turn/interrupt': {} } : {}) })[frame.method]);
    globalThis.__dshCancellationSpawn = () => child;
    const runtime = new CodexAppServerRuntime();
    const result = runtime.prompt(turn('codex-cli'));
    await flush();
    runtime.cancel(); runtime.cancel();
    assert.equal(child.frames.filter(frame => frame.method === 'turn/interrupt').length, 1);
    t.mock.timers.tick(2000);
    assert.equal(await result, 'thread');
    assert.equal(child.stdout.destroyed, true);
  });
}

test('Codex cancellation settles a stuck initialization RPC without a close event', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = fakeChild();
  globalThis.__dshCancellationSpawn = () => child;
  const runtime = new CodexAppServerRuntime();
  const result = assert.rejects(runtime.prompt(turn('codex-cli')), /Cancelled/);
  runtime.cancel();
  await result;
  assert.equal(child.stdin.destroyed, true);
});

test('Claude cancellation releases the caller without waiting for inherited pipes to close', async () => {
  const child = fakeChild();
  globalThis.__dshCancellationSpawn = () => child;
  const runtime = new OAuthCliRuntime();
  const result = runtime.prompt(turn('claude-cli'));
  runtime.cancel();
  assert.equal(await result, undefined);
  assert.equal(child.stdout.destroyed, true);
  const nextChild = fakeChild();
  globalThis.__dshCancellationSpawn = () => nextChild;
  const next = runtime.prompt(turn('claude-cli'));
  child.emit('close', 1);
  assert.equal(runtime.child, nextChild);
  runtime.cancel();
  await next;
});

test('ACP cancellation has a deadline and can restart without an old exit invalidating it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const makeChild = () => fakeChild(frame => ({ initialize: {}, authenticate: {}, 'session/new': { sessionId: 'session' } })[frame.method]);
  const child = makeChild();
  globalThis.__dshCancellationSpawn = () => child;
  const runtime = new AcpRuntime({ appendLine() {} }, async () => undefined);
  const route = { kind: 'cursor', command: 'cursor', args: [], cwd: '.' };
  await runtime.start(route);
  const result = assert.rejects(runtime.prompt('session', 'hello'), /stopped/);
  runtime.cancel('session'); runtime.cancel('session');
  t.mock.timers.tick(2000);
  await result;
  assert.equal(runtime.isRunning, false);
  const nextChild = makeChild();
  globalThis.__dshCancellationSpawn = () => nextChild;
  await runtime.start(route);
  child.emit('exit', 1);
  assert.equal(runtime.isRunning, true);
  assert.equal(await runtime.newSession('.'), 'session');
  await runtime.stop();
});

test('graceful ACP cancellation clears its deadline and keeps the runtime usable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = fakeChild();
  const runtime = new AcpRuntime({ appendLine() {} }, async () => undefined);
  runtime.child = child;
  const result = runtime.prompt('session', 'hello');
  const id = child.frames[0].id;
  runtime.cancel('session');
  await runtime.dispatch({ id, result: { stopReason: 'cancelled' } });
  assert.deepEqual(await result, { stopReason: 'cancelled' });
  t.mock.timers.tick(2000);
  assert.equal(runtime.isRunning, true);
  await runtime.stop();
});

test('filesystem event bursts queue one watcher scan and preserve the explicit final scan', async () => {
  const mirror = Object.create(WorkspaceMirror.prototype);
  mirror.opQueue = Promise.resolve();
  let release;
  let scans = 0;
  mirror.runScan = async () => {
    scans++;
    if (scans === 1) await new Promise(resolve => { release = resolve; });
  };
  const first = mirror.scheduleScan();
  await flush();
  for (let i = 0; i < 1000; i++) assert.equal(mirror.scheduleScan(), first);
  const final = mirror.scan();
  release();
  await final;
  assert.equal(scans, 2);
});

test('direct mode edits the real workspace and only attributes changes made during a turn', async () => {
  const { promises: fs } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  globalThis.__dshCancellationSpawn = () => { throw new Error('git unavailable'); };
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-direct-root-'));
  const storage = await fs.mkdtemp(join(tmpdir(), 'dsh-direct-storage-'));
  const reports = [];
  let mirror;
  try {
    await fs.writeFile(join(root, 'a.txt'), 'one');
    await fs.writeFile(join(root, 'b.txt'), 'two');
    mirror = await WorkspaceMirror.create({ scheme: 'file', fsPath: root }, storage, changes => reports.push(changes),
      '11111111-1111-4111-8111-111111111111', true);
    assert.equal(mirror.cwd, root);
    assert.deepEqual(await fs.readdir(storage), [], 'nothing is copied');

    await fs.writeFile(join(root, 'a.txt'), 'user before turn');
    await mirror.scan();
    assert.equal(reports.length, 0, 'edits between turns are not the agent\'s');

    await mirror.beginTurn();
    await fs.writeFile(join(root, 'a.txt'), 'agent');
    await fs.writeFile(join(root, 'c.txt'), 'created');
    await mirror.adopt('b.txt', 'user saved'); // onWillSaveTextDocument runs before the write
    await fs.writeFile(join(root, 'b.txt'), 'user saved');
    await mirror.endTurn();
    const last = Object.fromEntries(reports.at(-1).map(change => [change.path, change]));
    assert.deepEqual(Object.keys(last).sort(), ['a.txt', 'c.txt']);
    assert.deepEqual(last['a.txt'], { path: 'a.txt', base: 'user before turn', proposed: 'agent' });
    assert.deepEqual(last['c.txt'], { path: 'c.txt', base: undefined, proposed: 'created' });

    const count = reports.length;
    await fs.writeFile(join(root, 'a.txt'), 'user after turn');
    await mirror.scan();
    assert.equal(reports.length, count, 'recording stops when the turn ends');
  } finally {
    mirror?.dispose();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(storage, { recursive: true, force: true });
  }
});
