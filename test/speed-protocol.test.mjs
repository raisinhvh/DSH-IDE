import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { build } from 'esbuild';

let requests;
globalThis.__dshSpeedSpawn = () => {
  requests = [];
  const child = new EventEmitter();
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), killed: false });
  child.kill = () => { child.killed = true; return true; };
  let buffer = '';
  child.stdin.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      requests.push(request);
      if (request.id === undefined) continue;
      const result = request.method.startsWith('thread/') ? { thread: { id: 'thread' } }
        : request.method === 'turn/start' ? { turn: { id: 'turn' } } : {};
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
        if (request.method === 'turn/start') child.stdout.write(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn', status: 'completed' } } }) + '\n');
      });
    }
  });
  return child;
};
const bundle = await build({
  entryPoints: ['src/runtime/codexAppServer.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'mock-codex', setup(builder) {
    builder.onResolve({ filter: /^node:child_process$/ }, () => ({ path: 'process', namespace: 'fake' }));
    builder.onResolve({ filter: /accounts\/oauthCli$/ }, () => ({ path: 'account', namespace: 'fake' }));
    builder.onResolve({ filter: /^\.\/cancellation$/ }, () => ({ path: 'cancel', namespace: 'fake' }));
    builder.onLoad({ filter: /.*/, namespace: 'fake' }, ({ path }) => ({ contents: path === 'process'
      ? 'export const spawn = (...args) => globalThis.__dshSpeedSpawn(...args);'
      : path === 'account' ? 'export const cliCommand = () => "codex"; export const cliEnv = () => ({});'
      : 'export const terminateProcessTree = child => child.kill(); export const cancellationDeadline = () => () => {};' }));
  } }],
});
const { CodexAppServerRuntime } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('Codex sends speed separately on new and resumed turns and explicitly resets Standard', async () => {
  for (const sessionId of [undefined, 'thread']) {
    for (const [speed, tier] of [['Fast', 'fast'], ['Ultrafast', 'ultrafast'], ['None', 'default'], ['Standard', 'default']]) {
      await new CodexAppServerRuntime().prompt({
        account: { provider: 'codex-cli', directory: 'unused' }, cwd: process.cwd(), backend: 'base-model',
        readOnly: true, speed, sessionId, prompt: 'Hello', onText() {}, onTool() {},
      });
      const turn = requests.find(request => request.method === 'turn/start');
      assert.equal(turn.params.model, 'base-model');
      assert.equal(turn.params.serviceTierForTurn, tier);
      assert.ok(requests.some(request => request.method === (sessionId ? 'thread/resume' : 'thread/start')));
    }
  }
});
