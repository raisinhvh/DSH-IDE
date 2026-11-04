import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PushRejected, SyncClone } from '../dist/sync/gitRepo.mjs';
import { bundleToTree, describeChanges, hashBundle, mergeBundles, treeToBundle } from '../dist/sync/configSync.mjs';

const bundle = (files = {}, settings = {}, toolpacks = {}) => ({ format: 'dsh-config', version: 1, settings, files, toolpacks });
const hasGit = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();

async function remote(t) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-repo-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const url = join(base, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', url]);
  return { base, url };
}

test('a config round-trips through the repository layout, binary files included', () => {
  const config = bundle(
    { 'dsh/AGENTS.md': { data: '# Rules\n' }, 'memory/tools/rig.md': { data: 'Rig\n' }, 'memory/img/a.png': { data: Buffer.from([0, 255, 1]).toString('base64'), encoding: 'base64' } },
    { models: [{ name: 'M' }], 'features.autoName': false },
    { blender: { enabled: false, source: 'export default {}', settings: { 'config.json': { host: 'x' } } } },
  );
  const tree = bundleToTree(config);
  assert.ok(tree.has('settings/features.autoName.json'));
  assert.ok(tree.has('toolpacks/blender/source.ts'));
  assert.ok(tree.has('memory/tools/rig.md'));
  assert.deepEqual([...tree.get('memory/img/a.png')], [0, 255, 1]);
  assert.equal(hashBundle(treeToBundle(tree)), hashBundle(config));
  assert.equal(treeToBundle(new Map()), undefined);
  assert.throws(() => treeToBundle(new Map([['notes.md', Buffer.from('x')]])), /not made by DSH-IDE/);
  // Files DSH does not know (a user's own README edits, CI files) are ignored rather than rejected.
  tree.set('.github/workflows/x.yml', Buffer.from('x'));
  tree.set('memory/.obsidian/app.json', Buffer.from('{}'));
  assert.equal(hashBundle(treeToBundle(tree)), hashBundle(config));
});

test('a memory note changed on both PCs keeps both versions instead of pausing sync', () => {
  const base = bundle({ 'memory/a.md': { data: 'base' }, 'dsh/AGENTS.md': { data: 'base' } });
  const local = bundle({ 'memory/a.md': { data: 'mine' }, 'dsh/AGENTS.md': { data: 'mine' } });
  const remote = bundle({ 'memory/a.md': { data: 'theirs' }, 'dsh/AGENTS.md': { data: 'theirs' } });
  const { bundle: merged, conflicts } = mergeBundles(base, local, remote);
  assert.deepEqual(conflicts, ['~/.dsh/AGENTS.md']);
  assert.equal(merged.files['memory/a.md'].data, 'theirs');
  const copy = Object.keys(merged.files).find(key => /^memory\/a \(conflict .+\)\.md$/.test(key));
  assert.equal(merged.files[copy].data, 'mine');
  // First connect: no base, so everything on either side is kept.
  const union = mergeBundles(bundle(), bundle({ 'memory/x.md': { data: '1' } }), bundle({ 'memory/y.md': { data: '2' } }));
  assert.deepEqual(Object.keys(union.bundle.files).sort(), ['memory/x.md', 'memory/y.md']);
  assert.deepEqual(union.conflicts, []);
});

test('commit messages name what changed', () => {
  assert.equal(describeChanges(bundle(), bundle({ 'memory/a.md': { data: '1' } }, { models: [] }), 'PC1'), 'Sync from PC1: dsh.models, memory/a.md');
  assert.match(describeChanges(undefined, bundle({ a: { data: '1' }, b: { data: '1' }, c: { data: '1' }, d: { data: '1' } }), 'PC1'), /and 1 more$/);
});

test('two clones share config through the repository, and a stale push is rejected', { skip: !hasGit }, async t => {
  const { base, url } = await remote(t);
  const one = new SyncClone(join(base, 'one'), 'git');
  const two = new SyncClone(join(base, 'two'), 'git');
  await one.prepare(url);
  await two.prepare(url);
  assert.equal((await one.read()).size, 0);
  const first = bundle({ 'memory/a.md': { data: 'A\r\n' } }, { models: [1] });
  assert.equal(await one.write(bundleToTree(first), 'first'), true);
  assert.equal(await one.write(bundleToTree(first), 'again'), false);
  assert.equal(hashBundle(treeToBundle(await two.read())), hashBundle(first));

  // PC two reads, then PC one pushes; PC two's push is now stale.
  const second = bundle({ 'memory/a.md': { data: 'A\r\n' }, 'memory/b.md': { data: 'B' } }, { models: [1] });
  await one.read();
  await one.write(bundleToTree(second), 'second');
  await assert.rejects(two.write(bundleToTree(bundle({ 'memory/c.md': { data: 'C' } })), 'stale'), PushRejected);
  // Reading again recovers: the clone matches the remote, with the rejected commit gone.
  assert.equal(hashBundle(treeToBundle(await two.read())), hashBundle(second));

  // Deletions reach the remote too, and line endings are kept byte for byte.
  await two.write(bundleToTree(bundle({ 'memory/a.md': { data: 'A\r\n' } }, { models: [1] })), 'delete b');
  const after = treeToBundle(await one.read());
  assert.deepEqual(Object.keys(after.files), ['memory/a.md']);
  assert.equal(after.files['memory/a.md'].data, 'A\r\n');
  const log = execFileSync('git', ['--git-dir', url, 'log', '--format=%s', 'main']).toString().trim().split('\n');
  assert.deepEqual(log, ['delete b', 'second', 'first']);
});

test('Git installs only the official MinGit build for this PC, with its published checksum', async () => {
  const { pickMinGit, gitVersionOk } = await import('../dist/runtime/git.mjs');
  const asset = (name, digest = `sha256:${'a'.repeat(64)}`) => ({ name, digest, browser_download_url: `https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/${name}` });
  const assets = [asset('Git-2.56.0.4-64-bit.exe'), asset('MinGit-2.56.0.4-busybox-64-bit.zip'), asset('MinGit-2.56.0.4-64-bit.zip'), asset('MinGit-2.56.0.4-arm64.zip')];
  assert.equal(pickMinGit(assets, 'x64').name, 'MinGit-2.56.0.4-64-bit.zip');
  assert.equal(pickMinGit(assets, 'arm64').name, 'MinGit-2.56.0.4-arm64.zip');
  assert.equal(pickMinGit([asset('MinGit-2.47.1-64-bit.zip')], 'x64').sha256, 'a'.repeat(64));
  assert.throws(() => pickMinGit([{ ...asset('MinGit-2.56.0-64-bit.zip'), digest: undefined }], 'x64'), /SHA-256/);
  assert.throws(() => pickMinGit([{ ...asset('MinGit-2.56.0-64-bit.zip'), browser_download_url: 'https://example.com/MinGit.zip' }], 'x64'), /Unexpected Git download/);
  assert.throws(() => pickMinGit([asset('MinGit-2.56.0-busybox-64-bit.zip')], 'x64'), /no MinGit download/);
  assert.ok(gitVersionOk('git version 2.43.0'));
  assert.ok(gitVersionOk('git version 2.31.0.windows.1'));
  assert.ok(!gitVersionOk('git version 2.30.2'));
  assert.ok(!gitVersionOk('not git'));
});
