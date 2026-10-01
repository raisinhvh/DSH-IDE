import { test, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { transform } from 'esbuild';
import { ToolpackRegistry } from '../dist/toolpacks/registry.mjs';
import { formatAnswers, parseQuestions } from '../dist/sidebar/questions.mjs';

const freePort = () => new Promise(done => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)); });
});
const until = async (check, label) => {
  for (let i = 0; i < 100; i++) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`Timed out waiting for ${label}`);
};

const port = await freePort();
process.env.DSH_ROBLOX_PORT = String(port);
const dir = await mkdtemp(join(tmpdir(), 'dsh-toolpacks-'));
const registry = new ToolpackRegistry({
  dir: join(dir, 'packs'),
  workerPath: resolve('dist/toolpack-worker.js'),
  compile: async source => (await transform(source, { loader: 'ts', format: 'cjs', target: 'node20' })).code,
  callTimeoutMs: 5000,
});
await registry.start();
after(async () => { await registry.dispose(); await rm(dir, { recursive: true, force: true }); });

test('rejects a script without a valid default export', async () => {
  const file = join(dir, 'bad.ts');
  await writeFile(file, 'export const nothing = 1;');
  await assert.rejects(() => registry.add(file), /export default/);
  await writeFile(file, "export default { name: 'Bad Name', description: 'x', tools: [] };");
  await assert.rejects(() => registry.add(file), /lowercase/);
  assert.equal(registry.list().length, 0);
});

test('runs a multi-tool pack in a child process and namespaces its tools', async () => {
  const file = join(dir, 'echo.ts');
  await writeFile(file, `
    export default {
      name: 'echo',
      description: 'Echo things',
      tools: [
        { name: 'say', description: 'Say text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, run: (args: { text?: string }) => 'said ' + args.text },
        { name: 'sum', description: 'Add numbers', run: (args: { a: number; b: number }) => ({ total: args.a + args.b }) },
        { name: 'boom', description: 'Always fails', run: () => { throw new Error('kaput'); } },
        { name: 'big', description: 'Huge output', run: () => 'x'.repeat(200000) },
      ],
    };`);
  const info = await registry.add(file);
  assert.equal(info.id, 'echo');
  assert.equal(info.state, 'running');
  assert.deepEqual(registry.descriptors().map(item => item.name), ['echo_say', 'echo_sum', 'echo_boom', 'echo_big']);
  assert.equal((await registry.call('echo_say', { text: 'hi' })).text, 'said hi');
  assert.deepEqual(JSON.parse((await registry.call('echo_sum', { a: 2, b: 3 })).text), { total: 5 });
  const failure = await registry.call('echo_boom', {});
  assert.equal(failure.isError, true);
  assert.equal(failure.text, 'kaput');
  assert.match((await registry.call('echo_big', {})).text, /output truncated/);
  assert.equal((await registry.call('echo_missing', {})).isError, true);
  await registry.setEnabled('echo', false);
  assert.equal(registry.descriptors().length, 0);
  assert.equal((await registry.call('echo_say', { text: 'x' })).isError, true);
  await registry.remove('echo');
  assert.equal(registry.list().length, 0);
});

test('the Roblox toolpack bridges tool calls to a polling Studio plugin', async () => {
  const info = await registry.add(resolve('toolpacks/roblox.ts'));
  assert.equal(info.id, 'roblox');
  assert.deepEqual(info.tools.map(tool => tool.name), ['tree', 'find', 'properties', 'source', 'execute', 'places', 'output_log', 'selection', 'playtest']);
  const code = (await readFile(join(dir, 'packs', 'roblox', 'data', 'pairing-code.txt'), 'utf8')).trim();
  const base = `http://127.0.0.1:${port}`;
  await until(() => registry.list()[0].status.includes(code), 'pairing status');
  assert.match(registry.list()[0].status, /^Waiting for Roblox Studio/);

  const unpaired = await registry.call('roblox_tree', {});
  assert.equal(unpaired.isError, true);
  assert.match(unpaired.text, /not connected/);
  const executeUnpaired = await registry.call('roblox_execute', { code: 'print("hi")' });
  assert.equal(executeUnpaired.isError, true);
  assert.match(executeUnpaired.text, /not connected/);
  assert.equal((await fetch(`${base}/poll?place=x`, { headers: { 'x-dsh-token': 'WRONG' } })).status, 401);
  assert.equal((await fetch(`${base}/ping?place=x`, { headers: { 'x-dsh-token': 'WRONG' } })).status, 401);
  assert.match(registry.list()[0].status, /^Waiting for Roblox Studio/);
  // The plugin pings first so it can show "Connected" without waiting out a 20s long poll.
  assert.equal((await fetch(`${base}/ping?place=My%20Place&session=studio-window-1&placeId=1234`, { headers: { 'x-dsh-token': code } })).status, 200);
  await until(() => registry.list()[0].status.startsWith('Connected'), 'ping connection');

  // Behaves like the Studio plugin: long-poll, run the command, post the result.
  const plugin = async (answer) => {
    const polled = await fetch(`${base}/poll?place=${encodeURIComponent('My Place')}&session=studio-window-1&placeId=1234`, { headers: { 'x-dsh-token': code.toLowerCase() } });
    assert.equal(polled.status, 200);
    const command = await polled.json();
    const result = await fetch(`${base}/result`, { method: 'POST', headers: { 'x-dsh-token': code, 'content-type': 'application/json' }, body: JSON.stringify({ id: command.id, ...answer(command) }) });
    assert.equal(result.status, 200);
    return command;
  };

  // The first poll registers the plugin; with nothing queued it holds, so queue the call right after it connects.
  const call = (async () => { await until(() => registry.list()[0].status.startsWith('Connected'), 'connection'); return registry.call('roblox_tree', { path: 'ReplicatedStorage', depth: 1 }); })();
  const commandPromise = plugin(command => ({ ok: true, data: {
    root: { path: 'ReplicatedStorage', className: 'ReplicatedStorage', childCount: 2 },
    nodes: [{ path: 'ReplicatedStorage/Shared', name: 'Shared', className: 'Folder', depth: 1, childCount: 3 }, { path: 'ReplicatedStorage/Remote', name: 'Remote', className: 'RemoteEvent', depth: 1, childCount: 0 }],
    truncated: false, total: 2,
  } }));
  // Connected status needs a poll to have started, so open a first poll that the server answers with the queued command.
  const command = await commandPromise;
  assert.equal(command.op, 'tree');
  assert.deepEqual(command.args, { depth: 1, maxNodes: 300, path: 'ReplicatedStorage' });
  const tree = await call;
  assert.equal(tree.isError, undefined);
  assert.equal(tree.text, 'ReplicatedStorage [ReplicatedStorage]\n  Shared [Folder] (+3 children)\n  Remote [RemoteEvent]');
  assert.match(registry.list()[0].status, /^Connected to Roblox Studio \(place: My Place\)/);

  const assertExecuteValidationSkipsQueue = async (args, pattern) => {
    const invalid = await registry.call('roblox_execute', args);
    assert.equal(invalid.isError, true);
    assert.match(invalid.text, pattern);
    const probeCode = 'return "queue-probe"';
    const probeCall = registry.call('roblox_execute', { code: probeCode });
    const probeCommand = await plugin(() => ({ ok: true, data: { logs: [], returns: ['queue-probe'] } }));
    assert.equal(probeCommand.op, 'execute');
    assert.equal(probeCommand.args.code, probeCode);
    const probe = await probeCall;
    assert.equal(probe.isError, undefined);
    assert.equal(probe.text, 'Returns:\nqueue-probe');
  };

  await assertExecuteValidationSkipsQueue({}, /code must be a non-empty string/);
  await assertExecuteValidationSkipsQueue({ code: 1 }, /code must be a non-empty string/);
  await assertExecuteValidationSkipsQueue({ code: '' }, /code must be a non-empty string/);
  await assertExecuteValidationSkipsQueue({ code: '   \n\t' }, /code must be a nonblank string/);
  await assertExecuteValidationSkipsQueue({ code: 'x'.repeat(200_001) }, /code must be at most 200000 UTF-8 bytes/);
  await assertExecuteValidationSkipsQueue({ code: 'é'.repeat(100_001) }, /code must be at most 200000 UTF-8 bytes/);

  const instanceNewCode = [
    'local p = Instance.new("Part")',
    'p.Name = "DSHBridgeExecuteTest"',
    'p.Anchored = true',
    'p.Parent = workspace',
    'print("created", p:GetFullName())',
    'return p.Name',
  ].join('\n');
  const instanceCall = registry.call('roblox_execute', { code: instanceNewCode });
  const instanceCommand = await plugin(() => ({
    ok: true,
    data: { logs: ['created Workspace.DSHBridgeExecuteTest'], returns: ['DSHBridgeExecuteTest'] },
  }));
  assert.equal(instanceCommand.op, 'execute');
  assert.equal(instanceCommand.args.code, instanceNewCode);
  const instanceResult = await instanceCall;
  assert.equal(instanceResult.isError, undefined);
  assert.match(instanceResult.text, /^Output:\ncreated Workspace\.DSHBridgeExecuteTest\n\nReturns:\nDSHBridgeExecuteTest$/);

  const emptyCall = registry.call('roblox_execute', { code: '-- no output' });
  await plugin(() => ({ ok: true, data: { logs: [], returns: [] } }));
  const emptyResult = await emptyCall;
  assert.equal(emptyResult.isError, undefined);
  assert.equal(emptyResult.text, 'Code executed successfully.');

  const logsOnlyCode = 'print("done")';
  const logsOnlyCall = registry.call('roblox_execute', { code: logsOnlyCode });
  const logsOnlyCommand = await plugin(() => ({ ok: true, data: { logs: ['done'], returns: [] } }));
  assert.equal(logsOnlyCommand.op, 'execute');
  assert.equal(logsOnlyCommand.args.code, logsOnlyCode);
  const logsOnlyResult = await logsOnlyCall;
  assert.equal(logsOnlyResult.isError, undefined);
  assert.equal(logsOnlyResult.text, 'Output:\ndone');

  const returnsCode = 'return nil, false, workspace:GetFullName()';
  const returnsCall = registry.call('roblox_execute', { code: returnsCode });
  const returnsCommand = await plugin(() => ({
    ok: true,
    data: { logs: [], returns: ['nil', 'false', 'Workspace'] },
  }));
  assert.equal(returnsCommand.op, 'execute');
  assert.equal(returnsCommand.args.code, returnsCode);
  const returnsResult = await returnsCall;
  assert.equal(returnsResult.isError, undefined);
  assert.equal(returnsResult.text, 'Returns:\nnil\nfalse\nWorkspace');

  const runtimeCall = registry.call('roblox_execute', { code: 'print("before")\nerror("boom")' });
  await plugin(() => ({
    ok: false,
    error: 'boom\n\nOutput:\nbefore',
  }));
  const runtimeResult = await runtimeCall;
  assert.equal(runtimeResult.isError, true);
  assert.match(runtimeResult.text, /boom/);
  assert.match(runtimeResult.text, /Output:\nbefore/);

  const syntaxCall = registry.call('roblox_execute', { code: 'if then' });
  await plugin(() => ({
    ok: false,
    error: ':1: Incomplete statement: expected expression after \'if\'',
  }));
  const syntaxResult = await syntaxCall;
  assert.equal(syntaxResult.isError, true);
  assert.match(syntaxResult.text, /Incomplete statement/);
  assert.doesNotMatch(syntaxResult.text, /Output:/);

  const failing = registry.call('roblox_source', { path: 'Workspace/Missing' });
  await plugin(() => ({ ok: false, error: 'No instance at path "Workspace/Missing"' }));
  const failed = await failing;
  assert.equal(failed.isError, true);
  assert.match(failed.text, /No instance at path/);

  const invalid = await registry.call('roblox_find', {});
  assert.equal(invalid.isError, true);
  assert.match(invalid.text, /name or className/);

  const second = { name: 'Other Place', session: 'studio-window-2', placeId: '9876' };
  const first = { name: 'My Place', session: 'studio-window-1', placeId: '1234' };
  const studioHeaders = { 'x-dsh-token': code };
  const announce = async place => {
    const query = new URLSearchParams(place);
    assert.equal((await fetch(`${base}/ping?${query}`, { headers: studioHeaders })).status, 200);
  };
  await announce({ place: second.name, session: second.session, placeId: second.placeId });
  await until(() => registry.list()[0].status.includes('2 places'), 'two-place status');
  assert.match(registry.list()[0].status, /2 places: My Place, Other Place/);
  const places = await registry.call('roblox_places', {});
  assert.equal(places.text.includes('My Place | placeId: 1234 | session: studio-window-1'), true);
  assert.equal(places.text.includes('Other Place | placeId: 9876 | session: studio-window-2'), true);

  const ambiguous = await registry.call('roblox_tree', { path: 'Workspace' });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.text, /Several Roblox Studio places are connected/);
  assert.match(ambiguous.text, /Pass the place argument/);
  const unknown = await registry.call('roblox_tree', { place: 'missing' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /No connected Roblox Studio place matches/);
  assert.match(unknown.text, /My Place.*Other Place/);

  const pollFor = async (place) => {
    const query = new URLSearchParams(place);
    const response = await fetch(`${base}/poll?${query}`, { headers: studioHeaders });
    assert.equal(response.status, 200);
    return response.json();
  };
  const answer = async (command, data) => {
    const result = await fetch(`${base}/result`, { method: 'POST', headers: { ...studioHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ id: command.id, ok: true, data }) });
    assert.equal(result.status, 200);
  };
  const secondTree = registry.call('roblox_tree', { place: 'Other', path: 'Workspace' });
  const commandSecondTree = await pollFor({ place: second.name, session: second.session, placeId: second.placeId });
  assert.equal(commandSecondTree.op, 'tree');
  assert.deepEqual(commandSecondTree.args, { depth: 3, maxNodes: 300, path: 'Workspace' });
  await answer(commandSecondTree, { root: { path: 'Workspace', className: 'Workspace' }, nodes: [] });
  assert.equal((await secondTree).text, 'Workspace [Workspace]');
  const byPlaceId = registry.call('roblox_find', { place: '1234', name: 'Door' });
  const commandFirstFind = await pollFor({ place: first.name, session: first.session, placeId: first.placeId });
  assert.equal(commandFirstFind.op, 'find');
  assert.deepEqual(commandFirstFind.args, { limit: 50, name: 'Door' });
  await answer(commandFirstFind, { matches: [{ path: 'Workspace/Door', className: 'Part' }] });
  assert.equal((await byPlaceId).text, 'Workspace/Door [Part]');

  const assertInvalidWithoutCommand = async (tool, args, pattern) => {
    const result = await registry.call(tool, args);
    assert.equal(result.isError, true);
    assert.match(result.text, pattern);
  };
  await assertInvalidWithoutCommand('roblox_output_log', { limit: 0 }, /limit must be an integer from 1 to 1000/);
  await assertInvalidWithoutCommand('roblox_output_log', { level: 'bogus' }, /level must be all, output, info, warning, or error/);
  await assertInvalidWithoutCommand('roblox_selection', { action: 'set' }, /paths must be an array of strings when action is set/);
  await assertInvalidWithoutCommand('roblox_playtest', { action: 'bad' }, /action must be status, start, or stop/);
  await assertInvalidWithoutCommand('roblox_playtest', { action: 'start', mode: 'bad' }, /mode must be run or play/);

  const logCall = registry.call('roblox_output_log', { place: second.session, limit: 5, level: 'warning', contains: 'oops', sinceTimestamp: 1000, clear: true });
  const logCommand = await pollFor({ place: second.name, session: second.session, placeId: second.placeId });
  assert.equal(logCommand.op, 'output_log');
  assert.deepEqual(logCommand.args, { limit: 5, level: 'warning', contains: 'oops', sinceTimestamp: 1000, clear: true });
  await answer(logCommand, { entries: [{ timestamp: 1700000000, level: 'warning', message: 'oops' }], truncated: true });
  assert.equal((await logCall).text, '[22:13:20] WARNING oops\nLog results truncated.');

  const selectionCall = registry.call('roblox_selection', { place: 'My Place', action: 'set', paths: ['Workspace/Door'] });
  const selectionCommand = await pollFor({ place: first.name, session: first.session, placeId: first.placeId });
  assert.equal(selectionCommand.op, 'selection');
  assert.deepEqual(selectionCommand.args, { action: 'set', paths: ['Workspace/Door'] });
  await answer(selectionCommand, { selection: [{ path: 'Workspace/Door', className: 'Part' }], missing: ['Workspace/Gone'] });
  assert.equal((await selectionCall).text, 'Workspace/Door [Part]\nMissing: Workspace/Gone');

  const playtestCall = registry.call('roblox_playtest', { place: 'studio-window-1', action: 'start', mode: 'run' });
  const playtestCommand = await pollFor({ place: first.name, session: first.session, placeId: first.placeId });
  assert.equal(playtestCommand.op, 'playtest');
  assert.deepEqual(playtestCommand.args, { action: 'start', mode: 'run' });
  await answer(playtestCommand, { message: 'Run started.', state: 'running' });
  assert.equal((await playtestCall).text, 'Run started.\nstate: running');
});

test('parses and formats ask_questions input', () => {
  const parsed = parseQuestions({ questions: [{ question: ' Which bridge? ', header: 'A very long header that is trimmed', options: [{ label: 'HTTP', description: 'simple' }, { label: 'WebSocket' }, { label: '' }] }] });
  assert.ok('questions' in parsed);
  assert.equal(parsed.questions[0].question, 'Which bridge?');
  assert.equal(parsed.questions[0].header.length, 12);
  assert.equal(parsed.questions[0].options.length, 2);
  assert.ok('error' in parseQuestions({ questions: [] }));
  assert.ok('error' in parseQuestions({ questions: [{ question: 'q', options: [{ label: 'only one' }] }] }));
  assert.ok('error' in parseQuestions({ questions: Array.from({ length: 5 }, () => ({ question: 'q', options: [{ label: 'a' }, { label: 'b' }] })) }));
  assert.equal(formatAnswers(parsed.questions, ['HTTP']), '1. Which bridge?\n   Answer: HTTP');
  assert.match(formatAnswers(parsed.questions, null), /skipped/);
});
