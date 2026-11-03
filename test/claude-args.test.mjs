import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { build } from 'esbuild';

// Checks the Claude Code command line and usage reporting without starting the CLI.
const launches = [];
globalThis.__dshClaudeArgsTestSpawn = (command, args, options) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => { child.killed = true; };
  launches.push({ command, args, options, child });
  return child;
};

const bundled = await build({
  entryPoints: ['src/runtime/oauthCli.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'fake-cli', setup(builder) {
    builder.onResolve({ filter: /^node:child_process$/ }, () => ({ path: 'process', namespace: 'fake' }));
    builder.onResolve({ filter: /accounts\/oauthCli$/ }, () => ({ path: 'accounts', namespace: 'fake' }));
    builder.onLoad({ filter: /.*/, namespace: 'fake' }, ({ path }) => ({ contents: path === 'process'
      ? 'export const spawn = (...args) => globalThis.__dshClaudeArgsTestSpawn(...args);'
      : 'export const cliCommand = provider => provider; export const cliEnv = () => ({ HOME: "home" });' }));
  } }],
});
const { ClaudeCliRuntime, LEAN_SYSTEM, OAuthCliRuntime, claudeArgs, parseUsage } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const delegate = { command: 'node', args: ['delegate-server.js'], env: { DSH_DELEGATE_OWNER: 'owner' } };
const turn = (extras = {}) => ({ account: { provider: 'claude-cli' }, cwd: process.cwd(), backend: 'configured-model', prompt: 'Say hi', onText() {}, onTool() {}, ...extras });
const send = (child, event) => child.stdout.write(JSON.stringify(event) + '\n');

test('a normal Claude turn keeps the arguments it had before the refactor', () => {
  const args = claudeArgs(turn({ delegate, system: 'Rules', effort: 'high', sessionId: 'session-1' }));
  assert.deepEqual(args, [
    '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-prompt-tool', 'stdio', '--disallowedTools', 'Agent,Task', '--append-system-prompt', 'Rules',
    '--mcp-config', JSON.stringify({ mcpServers: { 'dsh-delegate': delegate } }), '--allowedTools', 'mcp__dsh-delegate',
    '--include-partial-messages', '--permission-mode', 'default', '--effort', 'high', '--model', 'configured-model', '--resume', 'session-1',
  ]);
  assert.deepEqual(claudeArgs(turn({ speed: 'Fast', backend: 'default' })).slice(0, 3), ['--print', '--settings', '{"fastMode":true}']);
  assert.ok(!claudeArgs(turn({ backend: 'default' })).includes('--model'));
});

test('a lean turn loads no Claude Code prompt, tools, MCP servers or session', () => {
  const args = claudeArgs(turn({ lean: true, delegate, sessionId: 'session-1', effort: 'low' }));
  for (const flag of ['--mcp-config', '--append-system-prompt', '--permission-prompt-tool', '--include-partial-messages', '--resume']) assert.ok(!args.includes(flag), flag);
  assert.ok(args.includes('--safe-mode'));
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--input-format') + 1], 'stream-json');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--system-prompt') + 1], LEAN_SYSTEM);
  assert.equal(args[args.indexOf('--model') + 1], 'configured-model');
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
});

test('lean turns use the five-minute cache, other turns only when asked', async () => {
  for (const [extras, ttl] of [[{ lean: true }, '5m'], [{}, undefined], [{ cacheTtl: '5m' }, '5m']]) {
    const result = new ClaudeCliRuntime().prompt(turn(extras));
    const launch = launches.at(-1);
    assert.equal(launch.options.env.CLAUDE_CODE_PROMPT_CACHE_TTL, ttl);
    assert.equal(launch.options.env.HOME, 'home');
    launch.child.emit('close', 0);
    await result;
  }
});

test('usage is reported from the result, with the context of the last main request', async () => {
  const reports = [];
  const inits = [];
  const result = new OAuthCliRuntime().prompt(turn({ onUsage: usage => reports.push(usage), onInit: info => inits.push(info) }));
  const { child } = launches.at(-1);
  send(child, { type: 'system', subtype: 'init', session_id: 'session-2', tools: ['Read', 'ToolSearch', 3], model: 'claude-opus' });
  send(child, { type: 'assistant', message: { id: 'm1', content: [], usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } } });
  send(child, { type: 'assistant', parent_tool_use_id: 'agent', message: { id: 'sub', content: [], usage: { input_tokens: 99999 } } });
  send(child, { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Hi' }], usage: { input_tokens: 3, cache_read_input_tokens: 1200, cache_creation_input_tokens: 40 } } });
  send(child, { type: 'result', result: 'Hi', usage: { input_tokens: 8, cache_read_input_tokens: 2200, cache_creation_input_tokens: 240, output_tokens: 12,
    cache_creation: { ephemeral_1h_input_tokens: 240, ephemeral_5m_input_tokens: 0 } } });
  await new Promise(resolve => setImmediate(resolve));
  child.emit('close', 0);
  assert.equal(await result, 'session-2');
  assert.deepEqual(inits, [{ tools: ['Read', 'ToolSearch'], model: 'claude-opus' }]);
  assert.deepEqual(reports, [{ total: { input: 8, cacheRead: 2200, cacheWrite: 240, cacheWrite1h: 240, cacheWrite5m: 0, output: 12 }, context: 1243 }]);
});

test('waiting on background tasks after the answer is reported, and ends when Claude resumes', async () => {
  const waits = [];
  const result = new ClaudeCliRuntime().prompt(turn({ onBackgroundWait: tasks => waits.push(tasks) }));
  const { child } = launches.at(-1);
  send(child, { type: 'system', subtype: 'task_started', task_id: 't1', description: 'Run the tests' });
  send(child, { type: 'result', result: 'Started the tests.' });
  send(child, { type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  send(child, { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Tests passed.' }] } });
  send(child, { type: 'result', result: 'Tests passed.' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(waits, [['Run the tests'], []]);
  assert.equal(child.stdin.writableEnded, true, 'stdin ends once no task is left');
  child.emit('close', 0);
  await result;
});

test('a CLI that exited ends the turn even when its output pipes stay open', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = new ClaudeCliRuntime().prompt(turn());
  const { child } = launches.at(-1);
  child.emit('exit', 0);
  t.mock.timers.tick(3_000);
  assert.equal(await result, undefined);
});

test('usage parsing ignores objects without token counts', () => {
  assert.equal(parseUsage(undefined), undefined);
  assert.equal(parseUsage({ service_tier: 'standard' }), undefined);
  assert.deepEqual(parseUsage({ input_tokens: 4 }), { input: 4, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, output: 0 });
});
