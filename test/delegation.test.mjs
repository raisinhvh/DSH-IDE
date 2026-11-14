import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { build } from 'esbuild';

// Exercise the runtime wire protocol without starting CLI processes or model turns.
const launches = [];
globalThis.__dshDelegateTestSpawn = (command, args, options) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => { child.killed = true; };
  const launch = { command, args, options, child };
  launches.push(launch);
  return child;
};

const bundled = await build({
  entryPoints: ['src/runtime/oauthCli.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'fake-cli', setup(builder) {
    builder.onResolve({ filter: /^node:child_process$/ }, () => ({ path: 'process', namespace: 'fake' }));
    builder.onResolve({ filter: /accounts\/oauthCli$/ }, () => ({ path: 'accounts', namespace: 'fake' }));
    builder.onLoad({ filter: /.*/, namespace: 'fake' }, ({ path }) => ({ contents: path === 'process'
      ? 'export const spawn = (...args) => globalThis.__dshDelegateTestSpawn(...args);'
      : 'export const cliCommand = provider => provider; export const cliEnv = () => ({});' }));
  } }],
});
const { OAuthCliRuntime, IDLE_CLOSE_MS, NO_IDLE_LIMIT_MS } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const delegate = { command: 'node', args: ['delegate-server.js'], env: { DSH_DELEGATE_OWNER: 'owner' } };
const turn = (provider, extras = {}) => ({ account: { provider }, cwd: process.cwd(), backend: 'configured-model', prompt: 'Say hi', onText() {}, onTool() {}, ...extras });

test('Claude CLI speed is passed through settings without changing the model argument', async () => {
  for (const [speed, fastMode] of [['Fast', true], ['None', false]]) {
    const result = new OAuthCliRuntime().prompt(turn('claude-cli', { speed }));
    const launch = launches.at(-1);
    assert.deepEqual(JSON.parse(launch.args[launch.args.indexOf('--settings') + 1]), { fastMode });
    assert.equal(launch.args[launch.args.indexOf('--model') + 1], 'configured-model');
    launch.child.emit('close', 0);
    await result;
  }
});

test('Claude denies native agents before approval callbacks and preserves the delegate MCP', async () => {
  for (const bridge of [undefined, delegate]) {
    let approvals = 0;
    const result = new OAuthCliRuntime().prompt(turn('claude-cli', { delegate: bridge, fullAccess: true, onApproval() { approvals++; return Promise.resolve(true); } }));
    const launch = launches.at(-1);
    assert.equal(launch.args[launch.args.indexOf('--disallowedTools') + 1], 'Agent,Task');
    assert.ok(!launch.args.includes('--forward-subagent-text'));
    if (bridge) assert.deepEqual(JSON.parse(launch.args[launch.args.indexOf('--mcp-config') + 1]), { mcpServers: { 'dsh-delegate': bridge } });
    const responses = [];
    launch.child.stdin.on('data', chunk => {
      const response = JSON.parse(String(chunk));
      if (response.type === 'control_response') responses.push(response);
    });
    await new Promise(resolve => setImmediate(resolve));
    for (const name of ['Agent', 'Task', 'collaboration.spawn_agent']) {
      launch.child.stdout.write(JSON.stringify({ type: 'control_request', request_id: name, request: { subtype: 'can_use_tool', tool_name: name } }) + '\n');
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(approvals, 0);
    assert.equal(responses.length, 3);
    assert.ok(responses.every(response => response.response.response.behavior === 'deny'));
    launch.child.stdout.write(JSON.stringify({ type: 'control_request', request_id: 'normal-tool', request: { subtype: 'can_use_tool', tool_name: 'Read', input: { path: 'file.txt' } } }) + '\n');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(approvals, 1);
    assert.equal(responses.at(-1).response.response.behavior, 'allow');
    launch.child.emit('close', 0);
    await result;
  }
});

test('Claude keeps stdin open after a result while background tasks can still ask permission', async () => {
  const result = new OAuthCliRuntime().prompt(turn('claude-cli', { onApproval: () => Promise.resolve(true) }));
  const launch = launches.at(-1);
  const responses = [];
  launch.child.stdin.on('data', chunk => { for (const line of String(chunk).split('\n').filter(Boolean)) { const message = JSON.parse(line); if (message.type === 'control_response') responses.push(message); } });
  const send = event => launch.child.stdout.write(JSON.stringify(event) + '\n');
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick();
  send({ type: 'system', subtype: 'task_started', task_id: 'shell-1' });
  send({ type: 'result', subtype: 'success', result: 'Started it.' });
  await tick();
  assert.equal(launch.child.stdin.writableEnded, false);
  send({ type: 'control_request', request_id: 'late', request: { subtype: 'can_use_tool', tool_name: 'PowerShell', input: { command: 'Get-Location' } } });
  await tick(); await tick();
  assert.equal(responses.at(-1).response.request_id, 'late');
  assert.equal(responses.at(-1).response.response.behavior, 'allow');
  send({ type: 'system', subtype: 'task_notification', task_id: 'shell-1', status: 'completed' });
  send({ type: 'result', subtype: 'success', result: 'Done.' });
  await tick();
  assert.equal(launch.child.stdin.writableEnded, true);
  launch.child.emit('close', 0);
  await result;
});

/** Starts a Claude turn whose fake CLI reports session state; collects the control responses DSH writes back. */
const stateTurn = () => {
  const result = new OAuthCliRuntime().prompt(turn('claude-cli', { onApproval: () => Promise.resolve(true) }));
  const launch = launches.at(-1);
  const responses = [];
  launch.child.stdin.on('data', chunk => { for (const line of String(chunk).split('\n').filter(Boolean)) { const message = JSON.parse(line); if (message.type === 'control_response') responses.push(message); } });
  const send = event => launch.child.stdout.write(JSON.stringify(event) + '\n');
  const state = value => send({ type: 'system', subtype: 'session_state_changed', state: value });
  const ask = id => send({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'PowerShell', input: { command: 'Get-Location' } } });
  return { result, launch, responses, send, state, ask };
};
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };

test('Claude asks for session state events so stdin is closed only once it is idle', async () => {
  const { result, launch } = stateTurn();
  assert.equal(launch.options.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1');
  launch.child.emit('close', 0);
  await result;
});

test('Claude keeps stdin open after an early result until it reports idle', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { result, launch, responses, send, state, ask } = stateTurn();
  await tick();
  // A resumed session can report a result before it has read the new message.
  state('running');
  send({ type: 'result', subtype: 'success', result: 'Earlier work.' });
  await tick();
  assert.equal(launch.child.stdin.writableEnded, false);
  ask('after-early-result');
  await tick();
  assert.equal(responses.at(-1).response.request_id, 'after-early-result');
  assert.equal(responses.at(-1).response.response.behavior, 'allow');
  send({ type: 'result', subtype: 'success', result: 'Done.' });
  state('idle');
  await tick();
  assert.equal(launch.child.stdin.writableEnded, false);
  t.mock.timers.tick(IDLE_CLOSE_MS);
  assert.equal(launch.child.stdin.writableEnded, true);
  launch.child.emit('close', 0);
  await result;
});

test('Claude going back to running within the idle grace keeps stdin open', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { result, launch, send, state } = stateTurn();
  await tick();
  state('running');
  send({ type: 'result', subtype: 'success', result: 'Done.' });
  state('idle');
  await tick();
  t.mock.timers.tick(IDLE_CLOSE_MS - 1);
  state('running');
  await tick();
  t.mock.timers.tick(NO_IDLE_LIMIT_MS - 1);
  assert.equal(launch.child.stdin.writableEnded, false);
  launch.child.emit('close', 0);
  await result;
});

test('Claude keeps stdin open through a background wait longer than two minutes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { result, launch, responses, send, state, ask } = stateTurn();
  await tick();
  state('running');
  send({ type: 'system', subtype: 'task_started', task_id: 'sleep-1', description: 'Wait for the install' });
  send({ type: 'result', subtype: 'success', result: 'Waiting on the install.' });
  state('idle');
  await tick();
  t.mock.timers.tick(30 * 60_000);
  assert.equal(launch.child.stdin.writableEnded, false);
  assert.ok(!launch.child.killed);
  send({ type: 'system', subtype: 'task_notification', task_id: 'sleep-1', status: 'completed' });
  state('running');
  ask('after-wait');
  await tick();
  assert.equal(responses.at(-1).response.request_id, 'after-wait');
  assert.equal(responses.at(-1).response.response.behavior, 'allow');
  send({ type: 'result', subtype: 'success', result: 'Screenshot taken.' });
  state('idle');
  await tick();
  t.mock.timers.tick(IDLE_CLOSE_MS);
  assert.equal(launch.child.stdin.writableEnded, true);
  launch.child.emit('close', 0);
  await result;
});

test('Claude AskUserQuestion is answered in the chat instead of as a permission prompt', async () => {
  const questions = [{ question: 'Which bridge?', header: 'Bridge', options: [{ label: 'HTTP' }, { label: 'WebSocket' }], multiSelect: false }];
  for (const [onQuestions, expected] of [
    [() => Promise.resolve({ 'Which bridge?': 'HTTP' }), { behavior: 'allow', updatedInput: { questions, answers: { 'Which bridge?': 'HTTP' } } }],
    [() => Promise.resolve('The user skipped these questions.'), { behavior: 'deny', message: 'The user skipped these questions.' }],
    [undefined, { behavior: 'deny', message: 'Asking the user is not available here. Continue with your best judgement.' }],
  ]) {
    let approvals = 0;
    const result = new OAuthCliRuntime().prompt(turn('claude-cli', { onQuestions, onApproval() { approvals++; return Promise.resolve(true); } }));
    const launch = launches.at(-1);
    const responses = [];
    launch.child.stdin.on('data', chunk => {
      const response = JSON.parse(String(chunk));
      if (response.type === 'control_response') responses.push(response);
    });
    await new Promise(resolve => setImmediate(resolve));
    launch.child.stdout.write(JSON.stringify({ type: 'control_request', request_id: 'ask', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions } } }) + '\n');
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(approvals, 0);
    assert.deepEqual(responses.at(-1).response.response, expected);
    launch.child.emit('close', 0);
    await result;
  }
});

test('trimming built-in tools drops unusable Claude tools and never touches core tools', async () => {
  const claude = new OAuthCliRuntime().prompt(turn('claude-cli', { trimTools: true }));
  const claudeLaunch = launches.at(-1);
  const denied = claudeLaunch.args[claudeLaunch.args.indexOf('--disallowedTools') + 1].split(',');
  for (const tool of ['Agent', 'Task', 'Workflow', 'SendMessage', 'ScheduleWakeup', 'CronCreate', 'EnterWorktree', 'Artifact', 'SendUserFile']) assert.ok(denied.includes(tool), tool);
  for (const tool of ['Bash', 'Read', 'Edit', 'Write', 'Skill', 'ToolSearch', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'TaskStop', 'Monitor', 'TodoWrite']) assert.ok(!denied.includes(tool), tool);
  claudeLaunch.child.emit('close', 0);
  await claude;
});
