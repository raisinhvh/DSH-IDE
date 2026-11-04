import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callLabel, fairShares, formatBatchResult, globPattern, isBatchTool, MAX_BATCH_CHARS, parseBatchCalls, runBatchFileTool } from '../dist/runtime/batch.mjs';
import { chatHistoryReply, formatMessages, handoffSummaryPrompt, toolLine } from '../dist/runtime/handoff.mjs';

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
