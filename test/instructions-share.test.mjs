import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, readFile, access, stat, rm, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shareInstructions } from '../dist/instructions/share.mjs';

const START = '<!-- dsh:shared-rules:start (managed by DSH-IDE; edit global rules in DSH instead) -->';
const END = '<!-- dsh:shared-rules:end -->';
const exists = path => access(path).then(() => true, () => false);
const text = path => readFile(path, 'utf8');

async function roots(t) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-share-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const result = { dshHome: join(base, 'dsh'), agentsHome: join(base, 'agents'), directory: join(base, 'account') };
  await mkdir(result.dshHome);
  await mkdir(result.agentsHome);
  return result;
}

async function skill(home, name, body = name) {
  const dir = join(home, 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), body);
  return dir;
}

test('Claude preserves user rules, updates in place, avoids writes, and removes its block', async t => {
  const r = await roots(t);
  await mkdir(r.directory);
  const file = join(r.directory, 'CLAUDE.md');
  const user = '# Private rules\r\nKeep these bytes.  ';
  await writeFile(file, user);
  await writeFile(join(r.dshHome, 'AGENTS.md'), '# Global\nBe brief. \n\n');
  assert.deepEqual(await shareInstructions('claude-cli', r.directory, r, true), { rules: true, skills: [] });
  const initial = `${user}\n\n${START}\n# Global\nBe brief.\n${END}`;
  assert.equal(await text(file), initial);
  await utimes(file, 1000000000, 1000000000);
  const before = (await stat(file)).mtimeMs;
  await shareInstructions('claude-cli', r.directory, r, true);
  assert.equal((await stat(file)).mtimeMs, before);
  assert.equal(await text(file), initial);
  await writeFile(file, initial + '\r\nUser suffix.  \r\n');
  await writeFile(join(r.dshHome, 'AGENTS.md'), 'Updated');
  await shareInstructions('claude-cli', r.directory, r, true);
  assert.equal(await text(file), `${user}\n\n${START}\nUpdated\n${END}\r\nUser suffix.  \r\n`);
  assert.deepEqual(await shareInstructions('claude-cli', r.directory, r, false), { rules: false, skills: [] });
  assert.equal(await text(file), user + '\r\nUser suffix.  \r\n');
});

test('rules created solely by sharing are deleted on disable or a blank/missing source', async t => {
  const r = await roots(t);
  const file = join(r.directory, 'CLAUDE.md');
  const source = join(r.dshHome, 'AGENTS.md');
  await shareInstructions('claude-cli', r.directory, r, true);
  assert.equal(await exists(r.directory), false);
  await writeFile(source, 'Global');
  await shareInstructions('claude-cli', r.directory, r, true);
  assert.equal(await text(file), `${START}\nGlobal\n${END}`);
  await shareInstructions('claude-cli', r.directory, r, false);
  assert.equal(await exists(file), false);
  for (const missing of [false, true]) {
    await writeFile(source, 'Global');
    await shareInstructions('claude-cli', r.directory, r, true);
    if (missing) await rm(source);
    else await writeFile(source, ' \n\t');
    assert.equal((await shareInstructions('claude-cli', r.directory, r, true)).rules, false);
    assert.equal(await exists(file), false);
  }
  await writeFile(file, ' \n\t');
  await shareInstructions('claude-cli', r.directory, r, false);
  assert.equal(await text(file), ' \n\t');
});

test('Codex writes AGENTS.md and only shares DSH skills', async t => {
  const r = await roots(t);
  await writeFile(join(r.dshHome, 'AGENTS.md'), 'Codex rules');
  await skill(r.dshHome, 'dsh-skill');
  await skill(r.agentsHome, 'agents-skill');
  assert.deepEqual(await shareInstructions('codex-cli', r.directory, r, true), { rules: true, skills: ['dsh-skill'] });
  assert.match(await text(join(r.directory, 'AGENTS.md')), /Codex rules/);
  assert.equal(await exists(join(r.directory, 'CLAUDE.md')), false);
  assert.equal(await exists(join(r.directory, 'skills', 'agents-skill')), false);
});

test('skills copy nested files, update and prune while preserving unmanaged CLI directories', async t => {
  const r = await roots(t);
  const source = await skill(r.dshHome, 'review');
  await mkdir(join(source, 'references'));
  await writeFile(join(source, 'references', 'old.txt'), 'old');
  await skill(r.dshHome, 'collision', 'source');
  await skill(r.directory, 'collision', 'user');
  await skill(r.directory, 'synced', 'CLI synced');
  await skill(r.directory, '.system', 'CLI system');
  const manifest = join(r.directory, 'skills', '.dsh-shared.json');
  const target = join(r.directory, 'skills', 'review');
  assert.deepEqual((await shareInstructions('claude-cli', r.directory, r, true)).skills, ['review']);
  assert.equal(await text(join(target, 'references', 'old.txt')), 'old');
  const value = JSON.parse(await text(manifest));
  assert.equal(value.version, 1);
  assert.match(value.skills.review.fingerprint, /^[a-f0-9]{64}$/);
  await utimes(join(target, 'SKILL.md'), 1000000000, 1000000000);
  await utimes(manifest, 1000000000, 1000000000);
  const before = (await stat(join(target, 'SKILL.md'))).mtimeMs;
  await shareInstructions('claude-cli', r.directory, r, true);
  assert.equal((await stat(join(target, 'SKILL.md'))).mtimeMs, before);
  assert.equal((await stat(manifest)).mtimeMs, 1000000000000);
  await rm(join(source, 'references', 'old.txt'));
  await writeFile(join(source, 'references', 'new.txt'), 'new');
  await shareInstructions('claude-cli', r.directory, r, true);
  assert.equal(await exists(join(target, 'references', 'old.txt')), false);
  assert.equal(await text(join(target, 'references', 'new.txt')), 'new');
  await rm(source, { recursive: true });
  assert.deepEqual((await shareInstructions('claude-cli', r.directory, r, true)).skills, []);
  assert.equal(await exists(target), false);
  assert.equal(await exists(manifest), false);
  await skill(r.dshHome, 'review');
  await shareInstructions('claude-cli', r.directory, r, true);
  await shareInstructions('claude-cli', r.directory, r, false);
  assert.equal(await exists(target), false);
  assert.equal(await exists(manifest), false);
  for (const [name, body] of [['collision', 'user'], ['synced', 'CLI synced'], ['.system', 'CLI system']]) {
    assert.equal(await text(join(r.directory, 'skills', name, 'SKILL.md')), body);
  }
});

test('Claude gives agentsHome precedence and returns managed names sorted', async t => {
  const r = await roots(t);
  await skill(r.dshHome, 'same', 'dsh');
  await skill(r.agentsHome, 'same', 'agents');
  await skill(r.dshHome, 'z-last');
  await skill(r.agentsHome, 'a-first');
  assert.deepEqual((await shareInstructions('claude-cli', r.directory, r, true)).skills, ['a-first', 'same', 'z-last']);
  assert.equal(await text(join(r.directory, 'skills', 'same', 'SKILL.md')), 'agents');
  await rm(join(r.agentsHome, 'skills', 'same'), { recursive: true });
  await shareInstructions('claude-cli', r.directory, r, true);
  assert.equal(await text(join(r.directory, 'skills', 'same', 'SKILL.md')), 'dsh');
});

test('corrupt manifests protect existing copies and invalid names cannot escape skills', async t => {
  const r = await roots(t);
  await skill(r.dshHome, 'existing', 'source');
  await skill(r.directory, 'existing', 'private');
  await skill(r.dshHome, '.hidden');
  await skill(r.dshHome, 'bad_name');
  await skill(r.dshHome, 'valid');
  const manifest = join(r.directory, 'skills', '.dsh-shared.json');
  await writeFile(manifest, '{bad json');
  assert.deepEqual((await shareInstructions('codex-cli', r.directory, r, true)).skills, ['valid']);
  assert.equal(await text(join(r.directory, 'skills', 'existing', 'SKILL.md')), 'private');
  await writeFile(manifest, JSON.stringify({ version: 1, skills: { '../outside': { fingerprint: 'x' } } }));
  await shareInstructions('codex-cli', r.directory, r, false);
  assert.equal(await text(join(r.directory, 'skills', 'existing', 'SKILL.md')), 'private');
  assert.equal(await exists(join(r.directory, 'skills', 'valid')), true);
});

test('oversized skills are skipped without preventing other skills or rules', async t => {
  const r = await roots(t);
  await writeFile(join(r.dshHome, 'AGENTS.md'), 'Rules still shared');
  const large = await skill(r.dshHome, 'large');
  await writeFile(join(large, 'large.bin'), Buffer.alloc(5 * 1024 * 1024));
  const many = await skill(r.dshHome, 'many');
  for (let i = 0; i < 200; i++) await writeFile(join(many, `${i}.txt`), 'x');
  await skill(r.dshHome, 'okay');
  assert.deepEqual(await shareInstructions('codex-cli', r.directory, r, true), { rules: true, skills: ['okay'] });
  assert.equal(await exists(join(r.directory, 'skills', 'large')), false);
  assert.equal(await exists(join(r.directory, 'skills', 'many')), false);
});

test('source junctions and nested symlinks are skipped', async t => {
  const r = await roots(t);
  const source = await skill(r.dshHome, 'real');
  const outside = join(r.agentsHome, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'private');
  try {
    await symlink(source, join(r.dshHome, 'skills', 'linked'), 'junction');
    await symlink(outside, join(source, 'linked-folder'), 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Symlinks unavailable'); return; }
    throw error;
  }
  assert.deepEqual((await shareInstructions('codex-cli', r.directory, r, true)).skills, ['real']);
  assert.equal(await exists(join(r.directory, 'skills', 'real', 'linked-folder')), false);
});

test('rules errors propagate after skills still get a chance to share', async t => {
  const r = await roots(t);
  await mkdir(join(r.dshHome, 'AGENTS.md'));
  await skill(r.dshHome, 'okay');
  await assert.rejects(shareInstructions('codex-cli', r.directory, r, true));
  assert.equal(await text(join(r.directory, 'skills', 'okay', 'SKILL.md')), 'okay');
});
