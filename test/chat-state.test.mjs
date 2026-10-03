import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const source = await readFile('src/extension.ts', 'utf8');
const bundle = await build({
  stdin: { contents: source + '\nexport { ExtensionHost, DshSidebarProvider, WorkspaceMirror };', resolveDir: resolve('src'), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm',
  logOverride: { 'import-is-undefined': 'silent' },
  plugins: [{ name: 'vscode-stub', setup(builder) {
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const workspace = { getConfiguration: () => ({ get: (_key, fallback) => fallback }) }; export const window = {}; export const Uri = { file: path => ({ fsPath: path }) };' }));
  } }],
});
const { ExtensionHost, DshSidebarProvider, WorkspaceMirror } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function navigationHost(records) {
  const host = Object.create(ExtensionHost.prototype);
  const store = new Map([['dsh.ide.sessions.v1', records], ['dsh.ide.activeSession.v1', records[0]?.id]]);
  const messages = [];
  Object.assign(host, {
    active: records[0], chats: new Map(), chatLoads: new Map(), promptStarts: new Map(), deletedSessions: new Set(),
    transcripts: new Map(), timelines: {}, modelChoices: {}, selectedModel: 'Model',
    context: { globalStorageUri: { fsPath: '/storage' }, workspaceState: {
      get: (key, fallback) => store.has(key) ? store.get(key) : fallback,
      update: (key, value) => { store.set(key, value); return Promise.resolve(); },
    } },
    root: () => ({ uri: { scheme: 'file', fsPath: '/workspace' } }),
    sidebar: { hasTimeline: () => true, postMessage: message => messages.push(message) },
    availableModel: () => ({ name: 'Model', provider: 'cursor-acp', backend: 'auto' }),
    effectiveModel: model => model, choiceFor: () => ({}), accounts: { getDefault: () => undefined },
    refreshModels() {}, refreshAccount: async () => {}, syncActiveView() {}, updateStatus() {},
    output: { appendLine() {} },
  });
  return { host, store, messages };
}

function promptChat(record, calls = []) {
  return {
    record, running: false, cancelRequested: false, queue: [], turnEntryId: '', segment: 0,
    startedTools: new Set(), subagentIds: new Set(), delegationToolIds: new Set(), subagentText: new Map(),
    turnReply: '', handoffPending: false, ownerId: 'owner', mirror: { cwd: '/workspace', beginTurn: async () => {}, endTurn: async () => { calls.push('scan'); } },
    runtime: { isRunning: true, prompt: async (_id, prompt) => { calls.push(['runtime prompt', prompt]); } },
  };
}

function preparePromptHost(records) {
  const fixture = navigationHost(records);
  const { host } = fixture;
  Object.assign(host, {
    sessions: () => records,
    pendingApprovals: new Map(),
    pendingQuestions: new Map(),
    replayTranscript: id => { if (!fixture.messages.some(message => message.type === 'timelineState' && message.sessionId === id)) host.sidebar.postMessage({ type: 'timelineState', sessionId: id, timeline: [], subagents: {} }); },
    availableModel: () => undefined, effectiveModel: model => model, choiceFor: () => ({}),
    editorContext: () => '', delegateConfig: () => undefined, saveTranscripts: async () => {},
    saveSession: async () => {}, postRun() {}, postQueue(chat) { fixture.messages.push({ type: 'queueState', sessionId: chat.record.id, items: chat.queue.map(item => item.prompt) }); },
    cancel(_all, id) { host.chats.get(id).cancelRequested = true; },
  });
  return fixture;
}

test('new chats appear without copying files or starting a provider', async () => {
  const { host, store, messages } = navigationHost([]);
  host.prepareChat = () => { throw new Error('New must not initialize the chat'); };
  await host.newChat();
  const record = store.get('dsh.ide.sessions.v1')[0];
  assert.equal(record.pendingMirror, true);
  assert.equal(host.chats.size, 0);
  assert.equal(host.chatLoads.size, 0);
  assert.equal(host.active.id, record.id);
  assert.ok(messages.some(message => message.type === 'sessionState' && message.activeSessionId === record.id));
});

test('switches publish the selected chat before slow persistence finishes', async () => {
  const records = [{ id: 'one', modelName: 'Model' }, { id: 'two', modelName: 'Model', pendingMirror: true }];
  const { host, messages } = navigationHost(records);
  const gate = deferred();
  const update = host.context.workspaceState.update;
  host.context.workspaceState.update = (key, value) => { update(key, value); return gate.promise; };
  const switched = host.continueChat('two');
  assert.equal(host.active.id, 'two');
  assert.ok(messages.some(message => message.type === 'sessionState' && message.activeSessionId === 'two'));
  gate.resolve();
  await switched;
});

test('switching warm idle chats keeps their runtime and review state', async () => {
  const records = [{ id: 'one', modelName: 'Model' }, { id: 'two', modelName: 'Model' }];
  const { host } = navigationHost(records);
  const first = { record: records[0], running: false };
  const second = { record: records[1], running: false };
  host.chats.set('one', first); host.chats.set('two', second);
  host.unloadChat = () => { throw new Error('Navigation must keep warm chats'); };
  host.prepareChat = () => { throw new Error('Navigation must reuse warm chats'); };
  await host.continueChat('two'); await host.continueChat('one');
  assert.equal(host.chat, first);
  assert.equal(host.chats.get('two'), second);
});

test('a slow earlier switch cannot replace a newer selection when loading finishes', async () => {
  const records = [{ id: 'one', modelName: 'Model', pendingMirror: true }, { id: 'two', modelName: 'Model' }];
  const { host, messages } = navigationHost(records);
  const gate = deferred();
  host.prepareChat = async record => { await gate.promise; return { record }; };
  const earlier = host.continueChat('two');
  await new Promise(resolve => setImmediate(resolve));
  await host.continueChat('one');
  gate.resolve(); await earlier;
  assert.equal(host.active.id, 'one');
  assert.equal(messages.filter(message => message.type === 'sessionState').at(-1).activeSessionId, 'one');
});

test('simultaneous chat loads share initialization and failed loads can retry', async () => {
  const record = { id: 'one' };
  const { host } = navigationHost([record]);
  const gate = deferred();
  let attempts = 0;
  host.prepareChat = () => { attempts++; return gate.promise; };
  const first = host.loadChat(record);
  const second = host.loadChat(record);
  assert.equal(first, second); assert.equal(attempts, 1);
  const failed = assert.rejects(first, /failed/);
  gate.reject(new Error('failed')); await failed;
  host.prepareChat = async () => { attempts++; return { record }; };
  assert.equal((await host.loadChat(record)).record, record);
  assert.equal(attempts, 2);
});

test('posts idle prompt before a gated chat load and starts it exactly once', async () => {
  const record = { id: 'one', modelName: 'Model', provider: 'cursor-acp', backend: 'auto', name: 'New chat' };
  const { host, messages } = preparePromptHost([record]);
  const gate = deferred();
  const calls = [];
  const chat = promptChat(record, calls);
  let loads = 0;
  host.loadChat = async selected => { loads++; assert.equal(selected, record); await gate.promise; host.chats.set(record.id, chat); return chat; };
  const sending = host.sendPrompt('hello');
  assert.deepEqual(messages.filter(message => message.type === 'userMessage').map(message => message.text), ['hello']);
  assert.equal(host.promptStarts.has(record.id), true);
  gate.resolve(); await sending;
  assert.equal(loads, 1);
  assert.equal(calls.filter(call => Array.isArray(call) && call[0] === 'runtime prompt').length, 1);
  assert.equal(messages.filter(message => message.type === 'userMessage').length, 1);
});

test('posts idle prompt before gated image persistence', async () => {
  const record = { id: 'one', modelName: 'Model', provider: 'cursor-acp', backend: 'auto' };
  const { host, messages } = preparePromptHost([record]);
  const gate = deferred();
  const calls = [];
  const chat = promptChat(record, calls);
  host.saveImages = async () => { await gate.promise; return []; };
  host.loadChat = async () => { host.chats.set(record.id, chat); return chat; };
  const sending = host.sendPrompt('with file', [{ name: 'photo.png', mimeType: 'image/png', data: 'YQ==' }]);
  assert.equal(messages.filter(message => message.type === 'userMessage').length, 1);
  assert.equal(host.promptStarts.has(record.id), true);
  gate.resolve(); await sending;
  assert.equal(calls.filter(call => Array.isArray(call) && call[0] === 'runtime prompt').length, 1);
});

test('startup remains bound to the selected chat if navigation changes while loading', async () => {
  const records = [
    { id: 'one', modelName: 'Model', provider: 'cursor-acp', backend: 'auto' },
    { id: 'two', modelName: 'Model', provider: 'cursor-acp', backend: 'auto' },
  ];
  const { host, messages } = preparePromptHost(records);
  const gate = deferred();
  const calls = [];
  const chat = promptChat(records[0], calls);
  host.loadChat = async selected => { assert.equal(selected, records[0]); await gate.promise; host.chats.set('one', chat); return chat; };
  const sending = host.sendPrompt('first chat');
  await new Promise(resolve => setImmediate(resolve));
  host.active = records[1];
  gate.resolve(); await sending;
  assert.deepEqual(messages.filter(message => message.type === 'userMessage').map(message => message.sessionId), ['one']);
  assert.deepEqual(calls.filter(call => Array.isArray(call) && call[0] === 'runtime prompt').map(call => call[1].split('User request:\n')[1]), ['first chat']);
});

test('failed startup releases reservation so the next submit can retry', async () => {
  const record = { id: 'one', modelName: 'Model', provider: 'cursor-acp', backend: 'auto' };
  const { host } = preparePromptHost([record]);
  const gate = deferred();
  const chat = promptChat(record);
  let attempts = 0;
  host.loadChat = async () => { attempts++; if (attempts === 1) { await gate.promise; throw new Error('load failed'); } host.chats.set(record.id, chat); return chat; };
  const first = host.sendPrompt('try one');
  const rejected = assert.rejects(first, /load failed/);
  gate.resolve(); await rejected;
  assert.equal(host.promptStarts.has(record.id), false);
  await host.sendPrompt('try two');
  assert.equal(attempts, 2);
  assert.equal(host.promptStarts.has(record.id), false);
});

test('rapid queue submission during startup produces one user echo and queues after load', async () => {
  const record = { id: 'one', modelName: 'Model', provider: 'cursor-acp', backend: 'auto' };
  const { host, messages } = preparePromptHost([record]);
  const gate = deferred();
  const promptGate = deferred();
  const calls = [];
  const chat = promptChat(record, calls);
  chat.runtime.prompt = async (_id, prompt) => { calls.push(['runtime prompt', prompt]); await promptGate.promise; };
  let loads = 0;
  host.loadChat = async () => { loads++; await gate.promise; host.chats.set(record.id, chat); return chat; };
  const first = host.sendPrompt('first');
  const second = host.sendPrompt('second', undefined, undefined, undefined, 'queue');
  assert.equal(messages.filter(message => message.type === 'userMessage').length, 1);
  gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await second;
  assert.equal(loads, 2);
  assert.equal(messages.filter(message => message.type === 'userMessage').length, 1);
  assert.deepEqual(chat.queue.map(item => item.prompt), ['second']);
  assert.equal(messages.filter(message => message.type === 'queueState').at(-1).items[0], 'second');
  assert.equal(calls.filter(call => Array.isArray(call) && call[0] === 'runtime prompt').length, 1);
  promptGate.resolve(); await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(messages.filter(message => message.type === 'userMessage').map(message => message.text), ['first', 'second']);
  assert.equal(calls.filter(call => Array.isArray(call) && call[0] === 'runtime prompt').length, 2);
});

test('rapid interrupt submission during startup queues once then requests cancellation', async () => {
  const record = { id: 'one', modelName: 'Model', provider: 'cursor-acp', backend: 'auto' };
  const { host, messages } = preparePromptHost([record]);
  const gate = deferred();
  const promptGate = deferred();
  const chat = promptChat(record);
  chat.runtime.prompt = async () => { await promptGate.promise; };
  host.loadChat = async () => { await gate.promise; host.chats.set(record.id, chat); return chat; };
  const first = host.sendPrompt('first');
  const second = host.sendPrompt('interrupt');
  gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await second;
  assert.equal(chat.cancelRequested, true);
  assert.deepEqual(chat.queue.map(item => item.prompt), ['interrupt']);
  assert.equal(messages.filter(message => message.type === 'userMessage').length, 1);
  promptGate.resolve(); await first;
});

test('first submission is displayed before new chat persistence completes', async () => {
  const records = [];
  const { host, messages } = preparePromptHost(records);
  const gate = deferred();
  host.availableModel = () => ({ name: 'Model', provider: 'cursor-acp', backend: 'auto' });
  host.saveSession = async record => { if (!records.includes(record)) records.push(record); await gate.promise; };
  host.loadChat = async record => { const chat = promptChat(record); host.chats.set(record.id, chat); return chat; };
  const sending = host.sendPrompt('first message');
  assert.equal(messages.filter(message => message.type === 'userMessage').length, 1);
  assert.equal(messages.find(message => message.type === 'userMessage').sessionId, host.active.id);
  gate.resolve(); await sending;
  assert.equal(messages.filter(message => message.type === 'userMessage').length, 1);
});

test('saved history is restored before the early user echo', async () => {
  const record = { id: 'one', modelName: 'Model', provider: 'cursor-acp', backend: 'auto' };
  const { host } = preparePromptHost([record]);
  host.sidebar = new DshSidebarProvider({});
  delete host.replayTranscript;
  host.timelines.one = { timeline: [{ id: 'old', kind: 'message', role: 'user', text: 'earlier' }], subagents: {} };
  const gate = deferred();
  host.loadChat = async () => { await gate.promise; return promptChat(record); };
  const sending = host.sendPrompt('new message');
  assert.deepEqual(host.sidebar.timeline('one').map(entry => entry.text), ['earlier', 'new message']);
  gate.resolve(); await sending;
  assert.deepEqual(host.sidebar.timeline('one').map(entry => entry.text), ['earlier', 'new message']);
});

test('deletion while switching models prevents a prepared turn from starting', async () => {
  const record = { id: 'one', modelName: 'Model', provider: 'cursor-acp', backend: 'auto' };
  const { host } = preparePromptHost([record]);
  const gate = deferred();
  const calls = [];
  const chat = promptChat(record, calls);
  host.chats.set(record.id, chat);
  host.availableModel = () => ({ name: 'Model', provider: 'cursor-acp', backend: 'different' });
  host.switchModel = async () => { await gate.promise; };
  const sending = host.sendPrompt('hello');
  await new Promise(resolve => setImmediate(resolve));
  host.deletedSessions.add(record.id);
  gate.resolve(); await sending;
  assert.equal(chat.running, false);
  assert.equal(calls.length, 0);
  assert.equal(host.promptStarts.size, 0);
});

test('deletion updates navigation before backend close and prevents late saves', async () => {
  const records = [{ id: 'one', modelName: 'Model' }, { id: 'two', modelName: 'Model', pendingMirror: true }];
  const { host, store, messages } = navigationHost(records);
  const gate = deferred();
  let disposed = false;
  host.chats.set('one', { record: records[0], running: false,
    runtime: { closeSession: () => gate.promise },
    review: { dispose() { disposed = true; } }, mirror: { dispose() {} },
  });
  const deleted = host.deleteSession('one');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposed, false);
  assert.equal(host.active.id, 'two');
  assert.deepEqual(store.get('dsh.ide.sessions.v1').map(record => record.id), ['two']);
  assert.ok(messages.some(message => message.type === 'sessionDeleted'));
  await host.saveSession(records[0]);
  assert.deepEqual(store.get('dsh.ide.sessions.v1').map(record => record.id), ['two']);
  gate.resolve(); await deleted;
  assert.equal(disposed, true);
});

test('retained chat limit protects active and running chats', () => {
  const records = Array.from({ length: 6 }, (_, index) => ({ id: String(index) }));
  const { host } = navigationHost(records);
  host.chats = new Map(records.map((record, index) => [record.id, { record, running: index === 1 }]));
  const evicted = [];
  host.unloadChat = async id => { evicted.push(id); host.chats.delete(id); };
  host.trimChats();
  assert.deepEqual(evicted, ['2', '3']);
  assert.ok(host.chats.has('0')); assert.ok(host.chats.has('1'));
});

test('first use keeps the local chat ID and stores the separately created backend ID', async t => {
  const record = { id: 'local', mirrorId: 'private-copy', pendingMirror: true, modelName: 'Model', provider: 'cursor-acp', backend: 'auto' };
  const { host } = navigationHost([record]);
  const mirror = { id: record.mirrorId, cwd: '/private', dispose() {} };
  t.mock.method(WorkspaceMirror, 'create', async (_root, _storage, _onChanges, id) => {
    assert.equal(id, record.mirrorId); return mirror;
  });
  const runtime = { newSession: async () => 'backend', models: () => [] };
  Object.assign(host, {
    createReview: () => ({ update() {}, dispose() {} }),
    ensureRuntime: async () => ({ runtime, key: 'provider' }),
    mcpServers: () => [], refreshCursorModels: async () => {},
  });
  const chat = await host.loadChat(record);
  assert.equal(chat.record.id, 'local');
  assert.equal(host.rid(record), 'backend');
  assert.equal(record.pendingMirror, undefined);
  assert.equal(host.chats.get('local'), chat);
});

test('reopening a chat preserves the initial scan results without scanning twice', async t => {
  const record = { id: 'local', runtimeId: 'backend', mirrorId: 'private-copy', modelName: 'Model', provider: 'cursor-acp', backend: 'auto' };
  const { host } = navigationHost([record]);
  const changes = [{ path: 'file.txt', base: 'before', proposed: 'after' }];
  const mirror = { id: record.mirrorId, cwd: '/private', dispose() {}, scan() { throw new Error('Redundant scan'); } };
  t.mock.method(WorkspaceMirror, 'reopen', async (_root, _storage, _id, onChanges) => {
    onChanges(changes); return mirror;
  });
  let reviewed, resumed;
  const runtime = { resumeSession: async id => { resumed = id; }, models: () => [] };
  Object.assign(host, {
    createReview: () => ({ update(value) { reviewed = value; }, dispose() {} }),
    ensureRuntime: async () => ({ runtime, key: 'provider' }),
    mcpServers: () => [], refreshCursorModels: async () => {},
  });
  await host.loadChat(record);
  assert.equal(reviewed, changes);
  assert.equal(resumed, 'backend');
});

test('deleting a draft during initialization disposes it without restoring the chat', async t => {
  const record = { id: 'local', mirrorId: 'private-copy', pendingMirror: true, modelName: 'Model', provider: 'cursor-acp', backend: 'auto' };
  const { host } = navigationHost([record]);
  const gate = deferred();
  const calls = [];
  t.mock.method(WorkspaceMirror, 'create', async () => {
    await gate.promise;
    return { id: record.mirrorId, cwd: '/private', dispose() { calls.push('dispose mirror'); } };
  });
  t.mock.method(WorkspaceMirror, 'remove', async () => { calls.push('remove mirror'); });
  Object.assign(host, {
    createReview: () => ({ update() {}, dispose() { calls.push('dispose review'); } }),
    ensureRuntime: async () => { throw new Error('Deleted chat must not start a provider'); },
  });
  const loading = host.loadChat(record);
  const failed = assert.rejects(loading, /deleted/);
  const deleting = host.deleteSession(record.id);
  gate.resolve();
  await failed; await deleting;
  assert.equal(host.chats.size, 0);
  assert.equal(host.sessions().length, 0);
  assert.deepEqual(calls, ['dispose review', 'dispose mirror', 'remove mirror']);
});

test('saved timelines restore tools, approvals and subagent output in order', () => {
  let saved;
  const sidebar = new DshSidebarProvider({}, undefined, (sessionId, timeline, subagents) => {
    saved = JSON.parse(JSON.stringify({ sessionId, timeline, subagents }));
  });
  sidebar.postMessage({ type: 'userMessage', sessionId: 'chat', entryId: 'user', text: 'hello' });
  sidebar.postMessage({ type: 'toolEvent', sessionId: 'chat', event: { id: 'read', kind: 'read', title: 'Read file', state: 'complete' } });
  sidebar.postMessage({ type: 'subagentEvent', sessionId: 'chat', agentId: 'child', title: 'Composer', text: 'Done', state: 'complete' });
  sidebar.postMessage({ type: 'approvalRequest', sessionId: 'chat', id: 'approval', title: 'Run', detail: 'command' });
  sidebar.postMessage({ type: 'approvalResolved', sessionId: 'chat', id: 'approval', allowed: true });
  sidebar.postMessage({ type: 'assistantDelta', sessionId: 'chat', entryId: 'answer', text: 'finished' });
  const restored = new DshSidebarProvider({});
  restored.postMessage({ type: 'timelineState', ...saved });
  assert.deepEqual(restored.timeline('chat').map(entry => entry.kind), ['message', 'tool', 'subagent', 'approval', 'message']);
  assert.equal(restored.subagents('chat').child.messages[0].text, 'Done');
  assert.equal(restored.timeline('chat')[3].status, 'allowed');
});

test('editing replaces the backend session and retains only the earlier conversation', async () => {
  const host = Object.create(ExtensionHost.prototype);
  const record = { id: 'chat', provider: 'deepseek-official', runtimeId: 'old', cliSessionId: 'old-cli' };
  const calls = [];
  const chat = { record, mirror: { cwd: '/workspace' }, running: false, ownerId: 'owner', runtime: {
    async newSession() { calls.push('new'); return 'fresh'; },
    async closeSession(id) { calls.push(['close', id]); },
  } };
  Object.assign(host, {
    active: record, chats: new Map([['chat', chat]]),
    transcripts: new Map([['chat', [
      { role: 'user', text: 'first' }, { role: 'assistant', text: 'earlier answer' },
      { role: 'user', text: 'second' }, { role: 'assistant', text: 'discard this' },
    ]]]),
    sidebar: {
      timeline: () => [
        { id: 'u1', kind: 'message', role: 'user', text: 'first' },
        { id: 'a1', kind: 'message', role: 'assistant', text: 'earlier answer' },
        { id: 'u2', kind: 'message', role: 'user', text: 'second' },
        { id: 'tool', kind: 'tool', event: { title: 'Discarded tool' } },
      ],
      subagents: () => ({ discarded: {} }),
      postMessage: message => calls.push(message),
    },
    mcpServers: () => [], saveSession: async () => {}, saveTranscripts: async () => {},
    sendPrompt: async text => calls.push(['prompt', text]),
  });
  await host.editMessage('chat', 'u2', 'changed');
  assert.equal(record.runtimeId, 'fresh');
  assert.equal(record.cliSessionId, undefined);
  assert.equal(chat.handoffPending, true);
  assert.deepEqual(host.transcripts.get('chat').map(item => item.text), ['first', 'earlier answer']);
  const reset = calls.find(item => item.type === 'timelineState');
  assert.deepEqual(reset.timeline.map(item => item.id), ['u1', 'a1']);
  assert.deepEqual(reset.subagents, {});
  assert.deepEqual(calls.at(-1), ['prompt', 'changed']);
});

test('editing a running chat cannot truncate it', async () => {
  const host = Object.create(ExtensionHost.prototype);
  host.active = { id: 'chat' };
  host.chats = new Map([['chat', { running: true }]]);
  await assert.rejects(host.editMessage('chat', 'u1', 'changed'), /finish before editing/);
});

test('replacing a cancelled Cursor runtime creates a fresh session and hands off conversation', async () => {
  const host = Object.create(ExtensionHost.prototype);
  const record = { id: 'chat', modelName: 'Cursor', provider: 'cursor-acp', accountId: 'cursor-login', backend: 'auto', runtimeId: 'old' };
  const old = { closeSession: async () => {} };
  const runtime = { newSession: async () => 'fresh', models: () => [] };
  const chat = { record, mirror: { cwd: '/workspace' }, ownerId: 'owner', runtimeKey: 'same-key', runtime: old };
  const model = { name: 'Cursor', provider: 'cursor-acp', backend: 'auto' };
  Object.assign(host, {
    resolveRoute: async () => ({ model }),
    ensureRuntime: async () => ({ key: 'same-key', runtime }),
    mcpServers: () => [], refreshCursorModels: async () => {},
    saveSession: async () => {}, refreshSessions() {},
  });
  await host.switchModel(chat, model);
  assert.equal(chat.runtime, runtime);
  assert.equal(record.runtimeId, 'fresh');
  assert.equal(chat.handoffPending, true);
});

test('late ACP tool events cannot overwrite Cancelling state', () => {
  const host = Object.create(ExtensionHost.prototype);
  host.chatForRuntime = () => ({ record: { id: 'chat' }, cancelRequested: true });
  host.sidebar = { postMessage() { throw new Error('Unexpected late event'); } };
  host.onRuntimeUpdate({ sessionId: 'runtime', update: { sessionUpdate: 'tool_call', toolCallId: 'late' } }, 'key');
});

test('uploads preserve non-image bytes and reject malformed or oversized data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-upload-'));
  try {
    const host = Object.create(ExtensionHost.prototype);
    host.context = { globalStorageUri: { fsPath: dir } };
    const payload = Buffer.from('context\nwith unicode: café');
    const saved = await host.saveImages([{ name: '../notes.txt', mimeType: 'text/plain', data: payload.toString('base64') }]);
    assert.deepEqual(await readFile(saved[0].path), payload);
    assert.equal(saved[0].path.startsWith(join(dir, 'attachments')), true);
    await assert.rejects(host.saveImages([{ name: 'bad', data: '!bad!' }]), /Invalid attachment/);
    await assert.rejects(host.saveImages([{ name: 'large', data: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') }]), /10 MB/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
