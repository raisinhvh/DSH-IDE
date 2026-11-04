import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BATCH_TOOL_SCHEMA, batchValue, callDependencies, callLabel, executeBatch, fairShares, formatBatchResult, globPattern, isBatchTool, MAX_BATCH_CHARS, parseBatchCalls, resolvePlaceholders, runBatchFileTool, uniqueBatchCalls } from '../dist/runtime/batch.mjs';
import { chatHistoryReply, formatMessages, handoffSummaryPrompt, toolLine } from '../dist/runtime/handoff.mjs';
import { buildPartsHandoff, parsePartsReply, partsPrompt, partWindows } from '../dist/runtime/transcriptParts.mjs';
import { SUMMARY_TOOL } from '../dist/summaries/store.mjs';

test('batch calls are validated, unqualified and may not nest', () => {
  assert.deepEqual(parseBatchCalls({ calls: [{ tool: 'mcp__dsh-delegate__read_file', args: { path: 'a' } }, { tool: 'list_subagents' }] }),
    [{ tool: 'read_file', args: { path: 'a' } }, { tool: 'list_subagents', args: {} }]);
  assert.throws(() => parseBatchCalls({ calls: [] }), /non-empty/);
  assert.throws(() => parseBatchCalls({ calls: [{ tool: 'batch', args: {} }] }), /another batch/);
  assert.throws(() => parseBatchCalls({ calls: Array.from({ length: 21 }, () => ({ tool: 'x' })) }), /at most 20/);
  assert.throws(() => parseBatchCalls({ calls: [{ args: {} }] }), /no tool name/);
  for (const name of ['batch', 'mcp__dsh-delegate__batch', 'dsh-delegate.batch']) assert.ok(isBatchTool(name), name);
  assert.ok(!isBatchTool('batchify'));
  assert.equal(callLabel({ tool: 'delegate_task', args: { agent: 'explorer', task: 'Find it' } }), 'delegate_task explorer');
});

test('identical calls in a batch run once', () => {
  const { calls, skipped } = uniqueBatchCalls(parseBatchCalls({ calls: [
    { tool: 'read_file', args: { path: 'src/a.ts', limit: 50 } },
    { tool: 'mcp__dsh-delegate__read_file', args: { limit: 50, path: './src\\a.ts' } },
    { tool: 'read_file', args: { path: 'src/a.ts', limit: 60 } },
    { tool: 'list_subagents' },
    { tool: 'list_subagents', args: {} },
  ] }));
  assert.deepEqual(calls.map(call => [call.tool, call.args.limit]), [['read_file', 50], ['read_file', 60], ['list_subagents', undefined]]);
  assert.equal(skipped, 2);
  assert.match(formatBatchResult([{ tool: 'a', args: {} }], [{ text: 'ok' }], 2).text, /\[2 identical calls skipped/);
});

test('chained calls may only refer to earlier calls', () => {
  const [, second, third] = parseBatchCalls({ calls: [
    { tool: 'figma_find', args: { name: 'Play' } },
    { tool: 'figma_properties', args: { node: '{{1[0].id}}', set: { name: 'Play button' } }, after: 1 },
    { tool: 'figma_properties', args: { node: '{{ item.id }}' }, forEach: '{{1}}' },
  ] });
  assert.deepEqual(second.after, [1]);
  assert.deepEqual(callDependencies(second), [1]);
  assert.equal(third.forEach, '{{1}}');
  assert.match(callLabel(third), /for each of \{\{1\}\}$/);
  assert.throws(() => parseBatchCalls({ calls: [{ tool: 'a', args: { x: '{{1.id}}' } }] }), /only use calls before it/);
  assert.throws(() => parseBatchCalls({ calls: [{ tool: 'a' }, { tool: 'b', args: { x: '{{3}}' } }] }), /only use calls before it/);
  assert.throws(() => parseBatchCalls({ calls: [{ tool: 'a' }, { tool: 'b', after: [2] }] }), /only use calls before it/);
  assert.throws(() => parseBatchCalls({ calls: [{ tool: 'a' }, { tool: 'b', args: { x: '{{item}}' } }] }), /without forEach/);
  assert.throws(() => parseBatchCalls({ calls: [{ tool: 'a' }, { tool: 'b', forEach: 'nodes' }] }), /one placeholder/);
});

test('dropping a repeated call renumbers the calls that refer to it', () => {
  const { calls, skipped } = uniqueBatchCalls(parseBatchCalls({ calls: [
    { tool: 'a' },
    { tool: 'a' },
    { tool: 'b', args: { x: '{{2.id}}', y: 'id {{1.id}}' } },
    { tool: 'c', after: [3] },
  ] }));
  assert.equal(skipped, 1);
  assert.deepEqual(calls[1].args, { x: '{{1.id}}', y: 'id {{1.id}}' });
  assert.deepEqual(calls[2].after, [2]);
});

test('placeholders read JSON results, JSON after text, or the whole text', () => {
  assert.deepEqual(batchValue('Updated asset 5.\n{"id": 5}').json, { id: 5 });
  assert.deepEqual(batchValue('Created asset 42.', { assetId: '42' }).json, { assetId: '42' });
  assert.equal(batchValue('Wrote C:/a.png [256x256]').isJson, false);
  const values = { 1: batchValue('{"nodes":[{"id":"1:2","w":10},{"id":"1:3","w":20}]}'), 2: batchValue('plain words') };
  const lookup = source => values[source];
  assert.deepEqual(resolvePlaceholders({ node: '{{1.nodes[0].id}}', width: '{{1.nodes[1].w}}', all: '{{1.nodes[*].id}}', label: 'node {{1.nodes[1].id}}: {{2}}' }, lookup),
    { node: '1:2', width: 20, all: ['1:2', '1:3'], label: 'node 1:3: plain words' });
  assert.throws(() => resolvePlaceholders('{{1.nodes[0].name}}', lookup), /call 1's result\.nodes\[0\] has no "name"\. Its keys: id, w\./);
  assert.throws(() => resolvePlaceholders('{{1.nodes[5]}}', lookup), /has 2 items/);
  assert.throws(() => resolvePlaceholders('{{2.id}}', lookup), /is text, not JSON/);
});

test('a batch waits for dependencies, fills placeholders, skips after failures and loops forEach', async () => {
  const order = [];
  const run = async call => {
    order.push(`${call.tool}:${JSON.stringify(call.args)}`);
    if (call.tool === 'find') { await new Promise(resolve => setTimeout(resolve, 20)); return { text: JSON.stringify([{ id: 'a' }, { id: 'b' }]) }; }
    if (call.tool === 'fail') return { text: 'nope', isError: true };
    if (call.tool === 'boom') throw new Error('thrown');
    return { text: JSON.stringify({ done: call.args.node ?? true }) };
  };
  const settled = [];
  const calls = parseBatchCalls({ calls: [
    { tool: 'find' },
    { tool: 'set', args: { node: '{{1[1].id}}' } },
    { tool: 'set', args: { node: '{{item.id}}' }, forEach: '{{1}}' },
    { tool: 'fail' },
    { tool: 'set', args: { node: 'x' }, after: [4] },
    { tool: 'set', args: { node: '{{3[*].done}}' } },
    { tool: 'boom' },
  ] });
  const outcomes = await executeBatch(calls, run, index => settled.push(index));
  assert.equal(outcomes[1].text, '{"done":"b"}');
  assert.match(outcomes[2].text, /^\(1\/2\) \{"done":"a"\}\n\(2\/2\) \{"done":"b"\}$/);
  assert.deepEqual(outcomes[4], { text: 'Skipped: call 4 failed.', isError: true });
  assert.equal(outcomes[5].text, '{"done":["a","b"]}');
  assert.deepEqual(outcomes[6], { text: 'thrown', isError: true });
  assert.ok(!order.includes('set:{"node":"x"}'));
  // The independent calls start before the slow find finishes; the dependent ones only after it.
  assert.deepEqual(order.slice(0, 3), ['find:{}', 'fail:{}', 'boom:{}']);
  assert.equal(settled.length, calls.length);
  const tooMany = parseBatchCalls({ calls: [{ tool: 'many' }, { tool: 'set', args: {}, forEach: '{{1}}' }] });
  const [, refused] = await executeBatch(tooMany, async call => call.tool === 'many' ? { text: JSON.stringify(Array.from({ length: 51 }, (_, i) => i)) } : { text: 'ok' });
  assert.match(refused.text, /has 51 items; at most 50/);
});

test('the result budget keeps short results whole and splits the rest evenly', () => {
  assert.deepEqual(fairShares([10, 500, 500], 410), [10, 200, 200]);
  assert.deepEqual(fairShares([1, 2], 100), [1, 2]);
  const calls = [{ tool: 'a', args: {} }, { tool: 'b', args: {} }];
  const { text } = formatBatchResult(calls, [{ text: 'short' }, { text: 'x'.repeat(MAX_BATCH_CHARS * 2), isError: true }]);
  assert.match(text, /^\[1\] a\nshort\n\n\[2\] b \(error\)\nx+\n\[cut at \d+ characters/);
  assert.ok(text.length < MAX_BATCH_CHARS + 200);
});

test('globs match basenames or slash paths', () => {
  assert.ok(globPattern('*.ts').test('a.ts'));
  assert.ok(!globPattern('*.ts').test('a.tsx'));
  assert.ok(globPattern('*.{js,mjs}').test('x.mjs'));
  assert.ok(globPattern('src/**/*.ts').test('src/a/b.ts'));
  assert.ok(globPattern('src/**/*.ts').test('src/b.ts'));
  assert.ok(!globPattern('src/*.ts').test('src/a/b.ts'));
});

test('batch file tools read, search and list inside the working copy only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-batch-'));
  const outside = await mkdtemp(join(tmpdir(), 'dsh-outside-'));
  try {
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'one\ntwo needle\nthree\n');
    await writeFile(join(root, 'src', 'b.js'), 'needle\n');
    await writeFile(join(root, 'node_modules', 'dep', 'c.ts'), 'needle\n');
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(root, 'link'), 'dir').catch(() => undefined);

    assert.equal((await runBatchFileTool(root, 'read_file', { path: 'src/a.ts' })).text, 'one\ntwo needle\nthree\n');
    assert.equal((await runBatchFileTool(root, 'read_file', { path: 'src/a.ts', offset: 2, limit: 1 })).text, '(lines 2-2 of 4)\ntwo needle');
    assert.equal((await runBatchFileTool(root, 'search', { pattern: 'needle' })).text, 'src/a.ts:2: two needle\nsrc/b.js:1: needle');
    assert.equal((await runBatchFileTool(root, 'search', { pattern: 'NEEDLE', glob: '*.ts', ignore_case: true })).text, 'src/a.ts:2: two needle');
    assert.match((await runBatchFileTool(root, 'list_dir', {})).text, /node_modules\/\nsrc\/$/);
    for (const path of ['../x', join(outside, 'secret.txt'), 'link/secret.txt']) {
      const result = await runBatchFileTool(root, 'read_file', { path });
      assert.equal(result.isError, true, path);
      assert.doesNotMatch(result.text, /^secret$/);
    }
    assert.match((await runBatchFileTool(root, 'read_file', { path: 'missing.ts' })).text, /does not exist/);
    assert.match((await runBatchFileTool(root, 'search', { pattern: '(' })).text, /Invalid pattern/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('chat history keeps tool lines and can be searched', () => {
  const history = [
    { role: 'user', text: 'Fix the parser' },
    { role: 'assistant', text: 'Fixed it.', tools: [toolLine('Edit', 'src/parser.ts'), toolLine('Bash', 'npm test')] },
    { role: 'user', text: 'Now the docs' },
    { role: 'assistant', text: 'Done.' },
  ];
  assert.equal(formatMessages(history.slice(1, 2)), 'Assistant: Fixed it.');
  assert.match(chatHistoryReply(history, 10), /\[Tools: Edit src\/parser\.ts; Bash npm test\]/);
  assert.equal(chatHistoryReply(history, 10, 'parser.ts edit'), 'Assistant: Fixed it.\n[Tools: Edit src/parser.ts; Bash npm test]');
  assert.match(chatHistoryReply(history, 10, 'nowhere'), /No earlier messages match/);
  assert.match(handoffSummaryPrompt(history), /\[Tools: Edit src\/parser\.ts/);
  assert.equal(toolLine('Read', `a\n${'x'.repeat(300)}`).length, 160);
});

test('transcript parts are split where the model says, within the window', () => {
  // Out-of-range, repeated and empty entries are dropped, and the first part always starts the window.
  const reply = 'Here:\n{"parts":[{"start":9,"title":"B","summary":"second"},{"start":7,"title":"A","summary":"first"},{"start":9,"summary":"dup"},{"start":30,"summary":"out"},{"start":10,"summary":""}]}';
  assert.deepEqual(parsePartsReply(reply, 5, 12), [
    { from: 5, to: 8, title: 'A', summary: 'first' },
    { from: 8, to: 12, title: 'B', summary: 'second' },
  ]);
  assert.equal(parsePartsReply('no json', 0, 4), undefined);
  assert.equal(parsePartsReply('{"parts":[]}', 0, 4), undefined);
  // Long stretches are summarized in several calls, cut at message boundaries.
  const history = Array.from({ length: 50 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: 'x'.repeat(5000) }));
  const windows = partWindows(history, 10, 50);
  assert.ok(windows.length > 1);
  assert.equal(windows[0].from, 10);
  assert.equal(windows.at(-1).to, 50);
  for (let index = 1; index < windows.length; index += 1) assert.equal(windows[index].from, windows[index - 1].to);
  assert.match(partsPrompt(windows[0]), /The first part starts at 11\./);
  const handoff = buildPartsHandoff('chat', history.slice(0, 4), [{ from: 0, to: 2, title: 'Start', summary: 'Did a thing.' }]);
  assert.match(handoff, /\.dsh\/transcripts\/chat\//);
  assert.match(handoff, /- part-01\.md \(messages 1-2\), Start: Did a thing\./);
});

test('batch and file summaries are never deferred behind Claude Code tool search', () => {
  assert.equal(BATCH_TOOL_SCHEMA._meta['anthropic/alwaysLoad'], true);
  assert.equal(SUMMARY_TOOL._meta['anthropic/alwaysLoad'], true);
});
