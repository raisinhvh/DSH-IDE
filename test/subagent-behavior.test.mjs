import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

// Expose the host only in this test bundle; no extension activation or model calls.
const bundle = await build({
  entryPoints: ['src/extension.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
  external: ['@deepseek-ai/dsh'],
  plugins: [{ name: 'host-test', setup(builder) {
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fake' }));
    builder.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: `
      export const workspace = { isTrusted: true };
      export const window = {}, commands = {}, env = {}, languages = {}, Uri = {};
      export const ConfigurationTarget = {}, StatusBarAlignment = {}, TextEditorRevealType = {};
      export class EventEmitter {} export class WorkspaceEdit {} export class Position {}
      export class Range {} export class Selection {} export class TabInputText {} export class RelativePattern {}
    ` }));
    builder.onLoad({ filter: /[\\/]src[\\/]extension\.ts$/ }, ({ path }) => ({
      contents: readFileSync(path, 'utf8') + '\nexport { ExtensionHost };', loader: 'ts',
    }));
  } }],
});
const { ExtensionHost } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function fixture(mode = 'edit') {
  const events = [];
  const host = Object.create(ExtensionHost.prototype);
  Object.assign(host, {
    childRuns: new Set(), sidebar: { postMessage: event => events.push(event) },
    subagentProfiles: () => [{ name: 'test-agent', model: 'test-model', mode }],
    availableModel: () => ({ name: 'test-model', enabled: true, backend: 'test', provider: 'deepseek-official' }),
    resolveRoute: async () => ({ model: {} }), releaseRuntime: async () => {}, mcpServers: () => [], summariesOn: () => false, autoCompactAt: () => undefined,
  });
  const chat = {
    record: { id: 'chat', modelName: 'test-model' }, turnEntryId: 'turn', mirror: { cwd: process.cwd() },
    children: new Set(), locks: new Map(), subagentIds: new Set(), delegationToolIds: new Set(),
    subagentText: new Map(), startedTools: new Set(), segment: 0,
  };
  let run;
  host.ensureRuntime = async () => ({ key: 'runtime', runtime: {
    newSession: async () => 'session', closeSession: async () => {},
    prompt: async (id, prompt) => {
      const child = [...host.childRuns][0];
      run = { prompt, readOnly: child.readOnly, locks: [...chat.locks.keys()] };
      child.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } });
    },
  } });
  return { host, chat, events, getRun: () => run };
}

test('edit profiles without file paths run read-only without taking locks', async () => {
  for (const files of [undefined, [], [' ', '']]) {
    const { host, chat, events, getRun } = fixture();
    assert.deepEqual(await host.runSubagent(chat, { agent: 'test-agent', task: 'Say hi', files }), { text: 'Hi' });
    assert.equal(getRun().readOnly, true);
    assert.match(getRun().prompt, /READ-ONLY/);
    assert.deepEqual(getRun().locks, []);
    assert.equal(events.at(-1).state, 'complete');
    assert.equal(chat.children.size, 0);
  }
});

test('explicit files enable editing only for edit profiles and release their locks', async () => {
  for (const mode of ['edit', 'read-only']) {
    const { host, chat, getRun } = fixture(mode);
    await host.runSubagent(chat, { agent: 'test-agent', task: 'Work', files: ['src/file.ts'] });
    assert.equal(getRun().readOnly, mode !== 'edit');
    assert.deepEqual(getRun().locks, mode === 'edit' ? ['src/file.ts'] : []);
    assert.equal(chat.locks.size, 0);
  }
});

test('an ACP subagent past the compaction threshold is stopped, checkpoints and finishes in a fresh session', async () => {
  const { host, chat } = fixture('read-only');
  host.autoCompactAt = () => 1000;
  host.output = { appendLine: () => {} };
  const prompts = [];
  const sessions = [];
  let interrupted = 0;
  host.ensureRuntime = async () => ({ key: 'runtime', runtime: {
    newSession: async () => { sessions.push(`session-${sessions.length + 1}`); return sessions.at(-1); },
    closeSession: async () => {},
    interrupt: () => { interrupted++; return true; },
    prompt: async (id, prompt) => {
      prompts.push({ id, prompt });
      const child = [...host.childRuns][0];
      const say = text => child.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      if (prompts.length === 1) {
        child.onUpdate({ sessionUpdate: 'usage_update', used: 500 });
        say('Step 1 done.');
        child.onUpdate({ sessionUpdate: 'usage_update', used: 2000 });
      } else if (prompts.length === 2) say('CHECKPOINT\n- Done: step 1\n- Next: step 2');
      else say('All steps done.');
    },
  } });
  const result = await host.runSubagent(chat, { agent: 'test-agent', task: 'Do two steps' });
  assert.equal(interrupted, 1);
  assert.deepEqual(prompts.map(item => item.id), ['session-1', 'session-1', 'session-2']);
  assert.match(prompts[1].prompt, /^DSH stopped your last step[\s\S]*CHECKPOINT/);
  assert.match(prompts[2].prompt, /Do two steps[\s\S]*- Next: step 2/);
  assert.equal(result.text, 'All steps done.');
});

test('delegation events never enter the tool bar or create a duplicate subagent card', () => {
  for (const title of ['delegate_task', 'mcp__dsh_delegate__delegate_task', 'dsh-delegate/delegate_task']) {
    const { host, chat, events } = fixture();
    host.chatForRuntime = () => chat;
    host.onRuntimeUpdate({ sessionId: 'session', update: { sessionUpdate: 'tool_call', toolCallId: 'delegate', title } }, 'runtime');
    host.onRuntimeUpdate({ sessionId: 'session', update: { sessionUpdate: 'tool_call_update', toolCallId: 'delegate', status: 'completed' } }, 'runtime');
    assert.deepEqual(events, []);
    assert.equal(chat.segment, 1);
    host.onRuntimeUpdate({ sessionId: 'session', update: { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read file' } }, 'runtime');
    assert.equal(events[0].type, 'toolEvent');
    assert.equal(chat.segment, 2);
  }
});

test('a batch runs DSH tools and file reads in parallel and returns one combined result', async () => {
  const { host, chat, events } = fixture('read-only');
  Object.assign(chat, { ownerId: 'owner', running: true, turnTools: [], cancelRequested: false });
  host.chats = new Map([['chat', chat]]);
  host.feature = key => key === 'batching';
  host.noteRead = () => {};
  host.packCall = () => undefined;
  const result = await host.handleDelegateCall('owner', 'batch', { calls: [
    { tool: 'delegate_task', args: { agent: 'test-agent', task: 'Say hi' } },
    { tool: 'read_file', args: { path: 'package.json', limit: 2 } },
    { tool: 'list_locked_files' },
    { tool: 'no_such_tool' },
  ] });
  assert.match(result.text, /^\[1\] delegate_task test-agent\nHi\n\n\[2\] read_file package\.json\n\(lines 1-2 of \d+\)\n\{\n  "name": "dsh-ide",\n\n\[3\] list_locked_files\nNo files are locked\.\n\n\[4\] no_such_tool \(error\)\nUnknown tool/);
  assert.equal(result.isError, undefined);
  assert.deepEqual(chat.turnTools, ['delegate_task test-agent', 'read_file package.json', 'list_locked_files', 'no_such_tool']);
  const card = events.filter(event => event.type === 'toolEvent').at(-1).event;
  assert.equal(card.title, 'Batch');
  assert.equal(card.state, 'complete');
  assert.deepEqual(card.children.map(child => [child.title, child.state]), [['delegate_task', 'complete'], ['read_file', 'complete'], ['list_locked_files', 'complete'], ['no_such_tool', 'error']]);

  const secret = await host.handleDelegateCall('owner', 'batch', { calls: [{ tool: 'read_file', args: { path: '.env' } }, { tool: 'search', args: { pattern: 'x', path: '../' } }] });
  assert.match(secret.text, /\[1\] read_file \.env \(error\)\n\.env needs approval/);
  assert.match(secret.text, /\[2\] search \.\.\/ \(error\)\n\.\.\/ needs approval/);

  host.feature = () => false;
  assert.deepEqual(await host.handleDelegateCall('owner', 'batch', { calls: [{ tool: 'list_locked_files' }] }), { text: 'Batching is turned off.', isError: true });
  assert.match((await host.handleDelegateCall('owner', 'batch', {})).text, /^Batching is turned off/);
  host.feature = () => true;
  assert.deepEqual(await host.handleDelegateCall('owner', 'batch', { calls: [{ tool: 'batch' }] }), { text: 'A batch cannot contain another batch.', isError: true });
});
