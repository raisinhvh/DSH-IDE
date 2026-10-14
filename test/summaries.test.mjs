import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSummaries, hashText, normalizePath, parseSummaries, readToolPath, summaryPrompt } from '../dist/summaries/store.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error('timed out'); await wait(20); }
}

async function fixture(reply = files => files.map(path => `=== SUMMARY ${path} ===\nSummary of ${path}`).join('\n')) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-summaries-'));
  const cwd = join(dir, 'workspace');
  await mkdir(join(cwd, 'src'), { recursive: true });
  const calls = [];
  let enabled = true;
  const summaries = new FileSummaries({
    file: join(dir, 'store', 'summaries.json'),
    generate: async (_cwd, prompt) => {
      const paths = [...prompt.matchAll(/^=== FILE (.+) ===$/gm)].map(match => match[1]);
      calls.push(paths);
      return reply(paths);
    },
    enabled: () => enabled,
    log: () => undefined,
    excluded: path => path === '.dsh' || path.startsWith('.dsh/'),
  });
  return { dir, cwd, calls, summaries, disable: () => { enabled = false; } };
}

test('paths are made relative to the working copy and kept inside it', () => {
  const cwd = join(tmpdir(), 'ws');
  assert.equal(normalizePath(cwd, join(cwd, 'src', 'a.ts')), 'src/a.ts');
  assert.equal(normalizePath(cwd, './src\\b.ts'), 'src/b.ts');
  assert.equal(normalizePath(cwd, 'src/'), 'src');
  assert.equal(normalizePath(cwd, '../outside.ts'), undefined);
  assert.equal(normalizePath(cwd, join(tmpdir(), 'other', 'x.ts')), undefined);
});

test('read tool paths come from Read inputs, even when the JSON was cut short', () => {
  assert.equal(readToolPath('Read', '{"file_path":"C:\\\\ws\\\\src\\\\a.ts","limit":20}'), 'C:\\ws\\src\\a.ts');
  assert.equal(readToolPath('Read', '{"file_path":"src/a.ts","offset":1'), 'src/a.ts');
  assert.equal(readToolPath('Edit', '{"file_path":"src/a.ts"}'), undefined);
  assert.equal(readToolPath('Read', undefined), undefined);
});

test('replies split into one summary per requested file', () => {
  const prompt = summaryPrompt([{ path: 'src/a.ts', text: 'export const a = 1;' }]);
  assert.match(prompt, /=== FILE src\/a\.ts ===\nexport const a = 1;/);
  const parsed = parseSummaries('=== SUMMARY src/a.ts ===\nPurpose: A.\n\n=== SUMMARY src/b.ts ===\n```\nPurpose: B.\n```\n=== SUMMARY other.ts ===\nignored', ['src/a.ts', 'src/b.ts']);
  assert.deepEqual([...parsed], [['src/a.ts', 'Purpose: A.'], ['src/b.ts', 'Purpose: B.']]);
  assert.deepEqual([...parseSummaries('Purpose: lone file.', ['a.ts'])], [['a.ts', 'Purpose: lone file.']]);
});

test('reads are summarized in one batch, saved, and skipped once current', async () => {
  const { dir, cwd, calls, summaries } = await fixture();
  await writeFile(join(cwd, 'src', 'a.ts'), 'export function a(): number { return 1; }');
  await writeFile(join(cwd, 'src', 'b.ts'), 'export function b(): void {}');
  summaries.request(cwd, join(cwd, 'src', 'a.ts'));
  summaries.request(cwd, 'src/b.ts');
  summaries.request(cwd, '.dsh/context/x.txt');
  await until(async () => calls.length === 1);
  assert.deepEqual(calls, [['src/a.ts', 'src/b.ts']]);
  assert.equal(await summaries.lookup(cwd, ['src/a.ts']), 'File: src/a.ts\nSummary of src/a.ts');
  summaries.request(cwd, 'src/a.ts');
  await wait(50);
  assert.equal(calls.length, 1);
  await until(async () => { try { return JSON.parse(await readFile(join(dir, 'store', 'summaries.json'), 'utf8'))['src/a.ts']?.hash === hashText('export function a(): number { return 1; }'); } catch { return false; } });
  summaries.dispose();
});

test('lookup writes missing summaries in one batch before replying', async () => {
  const { cwd, calls, summaries } = await fixture();
  await writeFile(join(cwd, 'src', 'a.ts'), 'one');
  await writeFile(join(cwd, 'src', 'b.ts'), 'two');
  assert.equal(await summaries.lookup(cwd, ['src/a.ts', 'src/b.ts']), 'File: src/a.ts\nSummary of src/a.ts\n\nFile: src/b.ts\nSummary of src/b.ts');
  assert.deepEqual(calls, [['src/a.ts', 'src/b.ts']]);
  assert.match(await summaries.lookup(cwd, ['src/missing.ts']), /Not found/);
  summaries.dispose();
});

test('changed files are rewritten when looked up', async () => {
  const { cwd, calls, summaries } = await fixture();
  await writeFile(join(cwd, 'src', 'a.ts'), 'one');
  await summaries.lookup(cwd, ['src/a.ts']);
  await writeFile(join(cwd, 'src', 'a.ts'), 'two');
  await wait(50);
  assert.equal(calls.length, 1);
  assert.equal(await summaries.lookup(cwd, ['src/a.ts']), 'File: src/a.ts\nSummary of src/a.ts');
  assert.equal(calls.length, 2);
  await summaries.lookup(cwd, ['src/a.ts']);
  assert.equal(calls.length, 2);
  summaries.dispose();
});

test('folders get a one-line overview from stored summaries and never write any', async () => {
  const { cwd, calls, summaries } = await fixture(files => files.map(path => `=== SUMMARY ${path} ===\nPurpose: Does ${path}.\nexport a(): void`).join('\n'));
  await mkdir(join(cwd, 'src', 'lib'));
  await mkdir(join(cwd, '.dsh'));
  await writeFile(join(cwd, 'src', 'a.ts'), 'one');
  await writeFile(join(cwd, 'src', 'b.ts'), 'two');
  await summaries.lookup(cwd, ['src/a.ts']);
  await writeFile(join(cwd, 'src', 'a.ts'), 'changed');
  const overview = 'Folder: src/\nlib/\na.ts: Does src/a.ts.\nb.ts (no summary yet)';
  assert.equal(await summaries.lookup(cwd, ['src']), overview);
  assert.equal(await summaries.lookup(cwd, ['src/']), overview);
  assert.equal(await summaries.lookup(cwd, ['.']), 'Folder: ./\nsrc/');
  assert.equal(calls.length, 1);
  summaries.dispose();
});

test('failed summaries fall back to reading the file, and nothing runs while disabled', async () => {
  const { cwd, calls, summaries, disable } = await fixture(() => '');
  await writeFile(join(cwd, 'src', 'a.ts'), 'one');
  assert.match(await summaries.lookup(cwd, ['src/a.ts']), /No summary could be written/);
  disable();
  await writeFile(join(cwd, 'src', 'c.ts'), 'three');
  await summaries.request(cwd, 'src/c.ts');
  await wait(50);
  assert.equal(calls.length, 1);
  summaries.dispose();
});
