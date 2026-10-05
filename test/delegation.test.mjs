import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { build } from 'esbuild';

// Exercise the runtime wire protocol without starting CLI processes or model turns.
const launches = [];
let codexItems = [];
globalThis.__dshDelegateTestSpawn = (command, args) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => { child.killed = true; };
  const launch = { command, args, requests: [], child };
  launches.push(launch);
  if (command === 'codex-cli') {
    let buffer = '';
    child.stdin.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        launch.requests.push(request);
        if (request.id === undefined) continue;
        const result = request.method === 'windowsSandbox/readiness' ? { status: 'ready' }
          : request.method.startsWith('thread/') ? { thread: { id: 'thread-1' } }
          : request.method === 'turn/start' ? { turn: { id: 'turn-1' } } : {};
        queueMicrotask(() => {
          child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
          if (request.method === 'turn/start') {
            for (const item of codexItems) {
              child.stdout.write(JSON.stringify({ method: 'item/started', params: { item } }) + '\n');
              if (item.type === 'agentMessage') child.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: item.text } }) + '\n');
              child.stdout.write(JSON.stringify({ method: 'item/completed', params: { item } }) + '\n');
            }
            child.stdout.write(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn-1' } } }) + '\n');
          }
        });
      }
    });
  }
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
const { OAuthCliRuntime } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
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

test('Codex preserves MCP tool names so delegation can be excluded from tool counts', async () => {
  const tools = [];
  codexItems = [{ id: 'delegate', type: 'mcpToolCall', server: 'dsh-delegate', tool: 'delegate_task', error: { message: 'failed' } }];
  try {
    await new OAuthCliRuntime().prompt(turn('codex-cli', { onTool: (...args) => tools.push(args) }));
    assert.equal(tools.length, 2);
    assert.ok(tools.every(tool => tool[1] === 'delegate_task'));
    assert.equal(tools[0][2], 'failed');
  } finally { codexItems = []; }
});

test('Codex disables native subagents on new and resumed threads, including delegated children', async () => {
  for (const sessionId of [undefined, 'existing-thread']) {
    for (const bridge of [undefined, delegate]) {
      await new OAuthCliRuntime().prompt(turn('codex-cli', { sessionId, delegate: bridge }));
      const launch = launches.at(-1);
      assert.equal(launch.args[launch.args.indexOf('--disable') + 1], 'multi_agent');
      assert.ok(!launch.args.includes('--enable'));
      const thread = launch.requests.find(request => request.method === (sessionId ? 'thread/resume' : 'thread/start'));
      assert.equal(thread.params.config['features.multi_agent'], false);
      assert.match(thread.params.developerInstructions, bridge ? /exact names/ : /no delegate tool/);
      if (bridge) {
        assert.ok(launch.args.includes('mcp_servers.dsh-delegate.default_tools_approval_mode="approve"'));
        assert.equal(thread.params.config['mcp_servers.dsh-delegate.default_tools_approval_mode'], 'approve');
        assert.equal(thread.params.config['mcp_servers.dsh-delegate.enabled'], true);
        assert.ok(launch.args.includes('mcp_servers.dsh-delegate.supports_parallel_tool_calls=true'));
        assert.equal(thread.params.config['mcp_servers.dsh-delegate.supports_parallel_tool_calls'], true);
      }
      assert.equal(thread.params.approvalPolicy, 'on-request');
      assert.equal(thread.params.sandbox, 'workspace-write');
    }
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

test('Codex marks each agent message so text around hidden tool lookups is never joined', async () => {
  const events = [];
  codexItems = [
    { id: 'm1', type: 'agentMessage', text: 'I will check.' },
    { id: 'lookup', type: 'toolSearchCall' },
    { id: 'm2', type: 'agentMessage', text: 'Yes.' },
  ];
  try {
    await new OAuthCliRuntime().prompt(turn('codex-cli', { onText: text => events.push(`text:${text}`), onMessageBreak: () => events.push('break') }));
    assert.deepEqual(events, ['break', 'text:I will check.', 'break', 'text:Yes.']);
  } finally { codexItems = []; }
});
