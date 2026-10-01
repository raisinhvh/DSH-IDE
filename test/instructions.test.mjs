import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listInstructions, readInstruction, removeInstruction, saveInstruction } from '../dist/instructions/store.mjs';

async function roots() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-instructions-'));
  const result = { workspace: join(base, 'ws'), dshHome: join(base, 'dsh'), agentsHome: join(base, 'agents') };
  for (const dir of Object.values(result)) await mkdir(dir, { recursive: true });
  return result;
}

const exists = path => access(path).then(() => true, () => false);

test('lists workspace and global rules and skills with their descriptions', async () => {
  const r = await roots();
  await writeFile(join(r.workspace, 'AGENTS.md'), '# rules');
  await mkdir(join(r.workspace, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(r.workspace, 'node_modules', 'pkg', 'AGENTS.md'), 'ignored');
  await mkdir(join(r.workspace, '.agents', 'skills', 'review'), { recursive: true });
  await writeFile(join(r.workspace, '.agents', 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: "Review a diff"\n---\nBody');
  await mkdir(join(r.agentsHome, 'skills', 'shared'), { recursive: true });
  await writeFile(join(r.agentsHome, 'skills', 'shared', 'SKILL.md'), '---\nname: shared\ndescription: Shared skill\n---\n');
  await writeFile(join(r.dshHome, 'AGENTS.md'), 'global');

  const items = await listInstructions(r);
  assert.deepEqual(items.map(item => [item.id, item.kind, item.scope, item.name]), [
    ['ws:AGENTS.md', 'rule', 'workspace', 'AGENTS.md'],
    ['ws:.agents/skills/review/SKILL.md', 'skill', 'workspace', 'review'],
    ['dsh:AGENTS.md', 'rule', 'global', 'AGENTS.md'],
    ['agents:skills/shared/SKILL.md', 'skill', 'global', 'shared'],
  ]);
  assert.equal(items[1].description, 'Review a diff');
  assert.equal(items[3].description, 'Shared skill');
});

test('adds a workspace rule and a skill, then edits and removes them', async () => {
  const r = await roots();
  const rule = await saveInstruction(r, { kind: 'rule', scope: 'workspace', file: 'CLAUDE.md', content: 'Be brief.' });
  assert.equal(rule.item.id, 'ws:CLAUDE.md');
  assert.equal(await readFile(join(r.workspace, 'CLAUDE.md'), 'utf8'), 'Be brief.');

  const skill = await saveInstruction(r, { kind: 'skill', scope: 'workspace', name: 'db-review', description: 'Use for: migrations', content: '# Steps\n\nCheck locks.' });
  const text = await readFile(skill.file, 'utf8');
  assert.match(text, /^---\nname: db-review\ndescription: "Use for: migrations"\n---\n\n# Steps/);
  assert.equal(skill.item.path, '.agents/skills/db-review/SKILL.md');

  await saveInstruction(r, { id: skill.item.id, kind: 'skill', scope: 'workspace', content: 'replaced' });
  assert.equal(await readInstruction(r, skill.item.id), 'replaced');

  await removeInstruction(r, skill.item.id);
  assert.equal(await exists(join(r.workspace, '.agents', 'skills', 'db-review')), false);
  assert.equal((await listInstructions(r)).some(item => item.kind === 'skill'), false);
});

test('adds global rules and skills outside the workspace', async () => {
  const r = await roots();
  await saveInstruction(r, { kind: 'rule', scope: 'global', file: 'AGENTS.md', content: '' });
  assert.match(await readFile(join(r.dshHome, 'AGENTS.md'), 'utf8'), /^# Rules/);
  const skill = await saveInstruction(r, { kind: 'skill', scope: 'global', name: 'helper', content: '' });
  assert.equal(skill.file, join(r.agentsHome, 'skills', 'helper', 'SKILL.md'));
  assert.match(await readFile(skill.file, 'utf8'), /# helper/);
});

test('refuses overwrites, bad names, unknown files and path escapes', async () => {
  const r = await roots();
  await saveInstruction(r, { kind: 'rule', scope: 'workspace', file: 'AGENTS.md', content: 'one' });
  await assert.rejects(saveInstruction(r, { kind: 'rule', scope: 'workspace', file: 'AGENTS.md', content: 'two' }), /already exists/);
  assert.equal(await readFile(join(r.workspace, 'AGENTS.md'), 'utf8'), 'one');
  await assert.rejects(saveInstruction(r, { kind: 'skill', scope: 'workspace', name: '../evil', content: '' }), /lowercase/);
  await assert.rejects(saveInstruction(r, { kind: 'rule', scope: 'workspace', file: 'package.json', content: '' }), /supported rules file/);
  await assert.rejects(saveInstruction(r, { kind: 'rule', scope: 'global', file: 'CLAUDE.md', content: '' }), /AGENTS\.md/);
  await assert.rejects(saveInstruction(r, { kind: 'rule', scope: 'elsewhere', file: 'AGENTS.md', content: '' }), /Choose a rule or skill/);
  for (const id of ['ws:../outside.md', 'ws:package.json', 'nope:AGENTS.md', 'ws:/etc/passwd']) {
    await assert.rejects(readInstruction(r, id));
    await assert.rejects(saveInstruction(r, { id, kind: 'rule', scope: 'workspace', content: 'x' }));
    await assert.rejects(removeInstruction(r, id));
  }
});

test('works without an open workspace folder', async () => {
  const r = await roots();
  r.workspace = undefined;
  await assert.rejects(saveInstruction(r, { kind: 'rule', scope: 'workspace', file: 'AGENTS.md', content: '' }), /Open a workspace/);
  await saveInstruction(r, { kind: 'rule', scope: 'global', file: 'AGENTS.md', content: 'g' });
  assert.deepEqual((await listInstructions(r)).map(item => item.id), ['dsh:AGENTS.md']);
});
