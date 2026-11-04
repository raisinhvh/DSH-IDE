import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRIMMED_IMAGE_NOTE, trimImageLines, trimSessionImages } from '../dist/runtime/imageTrim.mjs';

const image = n => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: `data${n}` } });
const toolResult = (...content) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content }] } });
const userImage = n => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'look' }, image(n)] } });
const assistant = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'an "image" word' }] } });

test('only the last images are kept, in tool results and user messages', () => {
  const lines = [userImage(1), assistant, toolResult({ type: 'text', text: '[Image: source: a.png]' }, image(2), image(3)), 'not json "image"', toolResult(image(4))];
  const { lines: out, removed } = trimImageLines(lines, 2);
  assert.equal(removed, 2);
  assert.equal(out[1], assistant);
  assert.equal(out[3], 'not json "image"');
  assert.equal(out[4], lines[4]);
  const first = JSON.parse(out[0]).message.content;
  assert.deepEqual(first[1], { type: 'text', text: TRIMMED_IMAGE_NOTE });
  const middle = JSON.parse(out[2]).message.content[0].content;
  assert.equal(middle[0].text, '[Image: source: a.png]');
  assert.deepEqual(middle[1], { type: 'text', text: TRIMMED_IMAGE_NOTE });
  assert.equal(middle[2].source.data, 'data3');
});

test('nothing changes when there are no more images than kept', () => {
  const lines = [toolResult(image(1)), assistant];
  const result = trimImageLines(lines, 5);
  assert.equal(result.removed, 0);
  assert.equal(result.lines, lines);
});

test('a saved session is rewritten in place', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-trim-'));
  try {
    const folder = join(dir, 'projects', 'c--Users-Me-game');
    await mkdir(folder, { recursive: true });
    const file = join(folder, 'abc.jsonl');
    await writeFile(file, [toolResult(image(1)), toolResult(image(2)), assistant].join('\n') + '\n');
    assert.equal(await trimSessionImages(dir, 'abc', 1), 1);
    const text = await readFile(file, 'utf8');
    assert.ok(text.endsWith('\n'));
    assert.ok(!text.includes('data1') && text.includes('data2'));
    assert.equal(await trimSessionImages(dir, 'missing', 1), 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
