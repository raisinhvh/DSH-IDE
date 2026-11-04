import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conflictName, globalMemoryFolder, isMemoryPath, memoryInstructions, memorySyncNeeded, syncGlobalMemory } from '../dist/runtime/memory.mjs';

const read = path => readFile(path, 'utf8');
async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-memory-'));
  const vault = join(base, 'vault'), cwd = join(base, 'project');
  await mkdir(join(vault, 'tools'), { recursive: true });
  await mkdir(join(vault, '.obsidian'), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(vault, 'Home.md'), '# Home\n');
  await writeFile(join(vault, 'tools', 'rig.md'), 'Rig builder\n');
  await writeFile(join(vault, '.obsidian', 'app.json'), '{}');
  return { base, vault, cwd, copy: join(cwd, '.dsh', 'global-memory') };
}
// Size and modification time decide whether a file changed, so edits in a test must move the time on.
async function touch(path, text) { await writeFile(path, text); const later = new Date(Date.now() + 5000); await utimes(path, later, later); }

test('global memory has a fixed home beside DSH\'s rules, and both memory folders are recognized', () => {
  assert.equal(globalMemoryFolder(join('home', '.dsh')), join('home', '.dsh', 'memory'));
  assert.ok(isMemoryPath('.dsh/global-memory/a.md'));
  assert.ok(isMemoryPath('./.dsh/memory/notes.md'));
  assert.ok(isMemoryPath('.dsh\\memory\\notes.md'));
  assert.ok(!isMemoryPath('.dsh/memoryx/a.md'));
  assert.ok(!isMemoryPath('src/a.ts'));
  assert.equal(conflictName('tools/rig.md', new Date(2026, 10, 4, 15, 30)), 'tools/rig (conflict 2026-11-04 1530).md');
});

test('the global vault syncs both ways through the working copy, and conflicts keep both versions', async () => {
  const { base, vault, cwd, copy } = await setup();
  try {
    assert.ok(!memorySyncNeeded(undefined, cwd));
    let result = await syncGlobalMemory(vault, cwd);
    assert.equal(result.pulled, 2);
    assert.equal(await read(join(copy, 'tools', 'rig.md')), 'Rig builder\n');
    assert.ok(!existsSync(join(copy, '.obsidian')));

    // The agent adds a note and edits one; both reach the real vault.
    await writeFile(join(copy, 'conventions.md'), 'Use metric units\n');
    await touch(join(copy, 'tools', 'rig.md'), 'Rig builder v2\n');
    result = await syncGlobalMemory(vault, cwd);
    assert.deepEqual(result.saved.sort(), ['conventions.md', 'tools/rig.md']);
    assert.equal(await read(join(vault, 'conventions.md')), 'Use metric units\n');
    assert.equal(await read(join(vault, 'tools', 'rig.md')), 'Rig builder v2\n');

    // The user edits the vault elsewhere; the copy picks it up. An agent deletion removes the note from the vault.
    await touch(join(vault, 'Home.md'), '# Home\nNew index\n');
    await rm(join(copy, 'conventions.md'));
    result = await syncGlobalMemory(vault, cwd);
    assert.equal(await read(join(copy, 'Home.md')), '# Home\nNew index\n');
    assert.ok(!existsSync(join(vault, 'conventions.md')));

    // Both sides changed the same note: the vault keeps its version and gains the agent's as a conflict copy.
    await touch(join(vault, 'tools', 'rig.md'), 'User version\n');
    await touch(join(copy, 'tools', 'rig.md'), 'Agent version\n');
    result = await syncGlobalMemory(vault, cwd);
    assert.equal(result.conflicts.length, 1);
    assert.equal(await read(join(vault, 'tools', 'rig.md')), 'User version\n');
    assert.equal(await read(join(copy, 'tools', 'rig.md')), 'User version\n');
    assert.equal(await read(join(vault, result.conflicts[0])), 'Agent version\n');
    await syncGlobalMemory(vault, cwd);
    assert.ok(existsSync(join(copy, result.conflicts[0])));

    // Nothing changed: nothing moves.
    result = await syncGlobalMemory(vault, cwd);
    assert.deepEqual([result.pulled, result.saved.length, result.conflicts.length], [0, 0, 0]);

    // Turning memory off removes the copy.
    assert.ok(memorySyncNeeded(undefined, cwd));
    await syncGlobalMemory(undefined, cwd);
    assert.ok(!existsSync(copy));
    assert.ok(!memorySyncNeeded(undefined, cwd));
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('switching to another vault replaces the copy instead of merging the old notes into it', async () => {
  const { base, vault, cwd, copy } = await setup();
  const other = join(base, 'other');
  try {
    await mkdir(other);
    await writeFile(join(other, 'only.md'), 'other vault\n');
    await syncGlobalMemory(vault, cwd);
    await syncGlobalMemory(other, cwd);
    assert.deepEqual(await readdir(copy), ['only.md']);
    assert.deepEqual((await readdir(other)).sort(), ['only.md']);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('the copy stays out of git and a vault containing the project is refused', async () => {
  const { base, vault, cwd } = await setup();
  try {
    await mkdir(join(cwd, '.git', 'info'), { recursive: true });
    await writeFile(join(cwd, '.git', 'info', 'exclude'), '# local\n');
    await syncGlobalMemory(vault, cwd);
    await syncGlobalMemory(vault, cwd);
    assert.equal(await read(join(cwd, '.git', 'info', 'exclude')), '# local\n/.dsh/global-memory/\n/.dsh/global-memory.json\n');
    const inside = join(vault, 'project');
    await mkdir(inside);
    assert.match((await syncGlobalMemory(vault, inside)).skipped, /contains this workspace/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('the memory instruction says where memory is and what is worth saving, and is empty without memory', async () => {
  const { base, vault, cwd } = await setup();
  try {
    assert.equal(memoryInstructions(cwd, true), '');
    await syncGlobalMemory(vault, cwd);
    const text = memoryInstructions(cwd, true);
    assert.match(text, /reusable code/);
    assert.doesNotMatch(text, /script|attachment|model/i);
    assert.match(text, /Global, for every project: \.dsh\/global-memory\/ \(start at Home\.md\)\./);
    assert.match(text, /This project: \.dsh\/memory\/ \(create it when needed\)\./);
    assert.match(text, /Save only what helps a future task/);
    assert.match(text, /Skip details that only matter to the current task/);
    assert.match(text, /Cross-project goes global; project-specific goes in the project/);
    assert.match(text, /project notes override global ones/);
    assert.ok(text.length < 650, String(text.length));
    // With memory off, nothing is said, even with a global copy or project memory in the working copy.
    await mkdir(join(cwd, '.dsh', 'memory'), { recursive: true });
    assert.equal(memoryInstructions(cwd, false), '');
    // With no global memory here, only the project's is described.
    await syncGlobalMemory(undefined, cwd);
    const projectOnly = memoryInstructions(cwd, true);
    assert.match(projectOnly, /This project: \.dsh\/memory\/\./);
    assert.doesNotMatch(projectOnly, /global|Cross-project/i);
  } finally { await rm(base, { recursive: true, force: true }); }
});
