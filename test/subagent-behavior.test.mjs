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
    resolveRoute: async () => ({ model: {} }), releaseRuntime: async () => {}, mcpServers: () => [],
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

test('chat and delegated native speeds keep the base backend with old suffixed settings', async () => {
  for (const provider of ['codex-cli', 'claude-cli']) {
    const { host, chat } = fixture('read-only');
    const model = { name: 'test-model', enabled: true, provider, backend: 'base-model', speedOptions: [
      { label: 'None', backend: 'base-model' }, { label: 'Fast', backend: 'base-model-fast' },
    ] };
    host.availableModel = () => model;
    host.modelChoices = { 'test-model': { speed: 'Fast' } };
    assert.equal(host.effectiveModel(model).backend, 'base-model');
    host.subagentProfiles = () => [{ name: 'test-agent', model: 'test-model', mode: 'read-only', speed: 'Fast' }];
    let routed;
    host.resolveRoute = async entry => { routed = entry; return { model: {} }; };
    await host.runSubagent(chat, { agent: 'test-agent', task: 'Say hi' });
    assert.equal(routed.backend, 'base-model');
  }
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
