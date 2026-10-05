import { test, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { transform } from 'esbuild';
import { ToolpackRegistry } from '../dist/toolpacks/registry.mjs';
import { answersByQuestion, formatAnswers, parseQuestions } from '../dist/sidebar/questions.mjs';


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
  assert.equal(parsed.questions[0].multiSelect, undefined);
});

test('maps chat answers onto Claude AskUserQuestion input', () => {
  const input = { questions: [{ question: ' Which bridge? ', options: [{ label: 'HTTP' }, { label: 'WebSocket' }], multiSelect: true }, { question: 'Port?', options: [{ label: '80' }, { label: '443' }] }] };
  const parsed = parseQuestions(input);
  assert.equal(parsed.questions[0].multiSelect, true);
  assert.deepEqual(answersByQuestion(input, ['HTTP, WebSocket', '443']), { ' Which bridge? ': 'HTTP, WebSocket', 'Port?': '443' });
});
