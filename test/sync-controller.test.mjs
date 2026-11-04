import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

// Two simulated PCs sync through a real git repository. A temporary global git config redirects the GitHub address
// to a local bare repository, so the controller runs unchanged; GitHub's REST API is answered by a fake fetch.
const hasGit = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();

const pcs = new Map();
globalThis.__dshSyncPc = undefined;
const answers = [];
const bundled = await build({
  entryPoints: ['src/sync/controller.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'vscode-stub', setup(builder) {
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `
      const pc = () => globalThis.__dshSyncPcs.get(globalThis.__dshSyncPc);
      export const ConfigurationTarget = { Global: 1 };
      export const workspace = { getConfiguration: () => ({
        inspect: key => ({ globalValue: pc().settings[key] }),
        update: async (key, value) => { if (value === undefined) delete pc().settings[key]; else pc().settings[key] = value; },
        get: (key, fallback) => pc().settings[key] ?? fallback,
      }) };
      export const authentication = { getSession: async () => ({ accessToken: 'tok', account: { label: 'me' } }) };
      export const window = { showWarningMessage: async () => globalThis.__dshSyncAnswers.shift() };
    ` }));
  } }],
});
globalThis.__dshSyncPcs = pcs;
globalThis.__dshSyncAnswers = answers;
const { ConfigSync } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

async function world(t) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-sync-e2e-'));
  const remote = join(base, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  const home = join(base, 'home');
  await mkdir(home);
  await writeFile(join(home, '.gitconfig'), `[url "${resolve(remote)}"]\n\tinsteadOf = https://github.com/me/dsh-sync.git\n[init]\n\tdefaultBranch = main\n`);
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, fetch: globalThis.fetch };
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  let exists = false;
  const repo = { private: true, full_name: 'me/dsh-sync', html_url: 'https://github.com/me/dsh-sync', clone_url: 'https://github.com/me/dsh-sync.git' };
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/repos/me/dsh-sync') return exists ? reply(200, repo) : reply(404, { message: 'Not Found' });
    if (path === '/user/repos' && init.method === 'POST') { exists = true; return reply(201, repo); }
    if (path === '/gists') return reply(200, []);
    return reply(404, { message: 'unexpected' });
  };
  t.after(async () => {
    process.env.HOME = saved.HOME;
    if (saved.XDG_CONFIG_HOME !== undefined) process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME;
    globalThis.fetch = saved.fetch;
    for (const pc of pcs.values()) pc.sync.dispose();
    pcs.clear();
    await rm(base, { recursive: true, force: true });
  });

  const makePc = async (name, settings = {}) => {
    const root = join(base, name);
    const pc = {
      name, settings, state: new Map(), memory: join(root, 'memory'),
      roots: { dshHome: join(root, 'dsh'), agentsHome: join(root, 'agents'), toolpacks: join(root, 'toolpacks') },
    };
    await mkdir(pc.memory, { recursive: true });
    const context = {
      globalStorageUri: { fsPath: join(root, 'storage') },
      globalState: { get: (key, fallback) => pc.state.has(key) ? pc.state.get(key) : fallback, update: async (key, value) => { pc.state.set(key, value); } },
    };
    pc.sync = new ConfigSync(context, {
      roots: () => ({ ...pc.roots, memory: pc.settings['memory.globalPath'] }),
      accounts: () => [],
      toolpacks: { list: () => [], add: async () => {}, remove: async () => {}, setEnabled: async () => {} },
      git: async () => 'git',
      adoptMemoryRoot: async () => { pc.settings['memory.globalPath'] = join(root, 'adopted'); return pc.settings['memory.globalPath']; },
      log: () => {}, post: state => { pc.posted = state; }, applied: async () => {},
    });
    pc.settings['memory.globalPath'] = pc.memory;
    pcs.set(name, pc);
    pc.on = async action => { globalThis.__dshSyncPc = name; const result = await action(pc.sync); return result; };
    pc.check = () => pc.on(sync => { sync.ready = true; return sync.run('checking', () => sync.withRetry(() => sync.sync()), true); });
    return pc;
  };
  const log = () => execFileSync('git', ['--git-dir', remote, 'log', '--format=%s', 'main']).toString().trim().split('\n');
  const remoteFile = path => execFileSync('git', ['--git-dir', remote, 'show', `main:${path}`]).toString();
  const remoteFiles = () => execFileSync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main']).toString().trim().split('\n');
  return { makePc, log, remoteFile, remoteFiles };
}

const note = (pc, name, text) => writeFile(join(pc.memory, name), text);
const read = path => readFile(path, 'utf8');

test('two PCs share settings, rules and memory through the sync repository without losing either side', { skip: !hasGit }, async t => {
  const { makePc, log, remoteFile, remoteFiles } = await world(t);
  const a = await makePc('a', { models: ['from A'] });
  await mkdir(a.roots.dshHome, { recursive: true });
  await writeFile(join(a.roots.dshHome, 'AGENTS.md'), '# A rules\n');
  await note(a, 'rig.md', 'Rig builder\n');
  await a.on(sync => sync.connect());
  assert.equal(a.posted.error, undefined);
  assert.equal(a.posted.connected, true);
  assert.equal(a.posted.repo, 'me/dsh-sync');
  assert.equal(remoteFile('memory/rig.md'), 'Rig builder\n');
  assert.equal(remoteFile('settings/models.json'), '[\n  "from A"\n]\n');
  assert.ok(remoteFiles().includes('README.md'));

  // PC B has its own note and a different model list. Connecting combines everything and asks only about the models.
  const b = await makePc('b', { models: ['from B'] });
  await note(b, 'units.md', 'Use metric\n');
  answers.push('Keep GitHub copy');
  await b.on(sync => sync.connect());
  assert.equal(b.posted.error, undefined);
  assert.deepEqual(b.settings.models, ['from A']);
  assert.equal(await read(join(b.roots.dshHome, 'AGENTS.md')), '# A rules\n');
  assert.deepEqual((await readdir(b.memory)).sort(), ['rig.md', 'units.md']);
  assert.equal(remoteFile('memory/units.md'), 'Use metric\n');

  // A picks up B's note on its next check; nothing of A's is lost.
  await a.check();
  assert.deepEqual((await readdir(a.memory)).sort(), ['rig.md', 'units.md']);
  assert.deepEqual(a.settings.models, ['from A']);

  // An agent on A saves a note: one commit names it, and B receives it.
  await note(a, 'tools.md', 'Reusable model tool\n');
  await a.check();
  assert.match(log()[0], /^Sync from .+: memory\/tools\.md$/);
  await b.check();
  assert.equal(await read(join(b.memory, 'tools.md')), 'Reusable model tool\n');

  // Both PCs edit the same note: GitHub's version wins in place and the other is kept beside it on every PC.
  await note(a, 'rig.md', 'A version\n');
  await a.check();
  await note(b, 'rig.md', 'B version\n');
  await b.check();
  assert.equal(b.posted.conflict, undefined);
  assert.equal(await read(join(b.memory, 'rig.md')), 'A version\n');
  const copy = (await readdir(b.memory)).find(name => name.startsWith('rig (conflict '));
  assert.ok(copy, 'conflict copy on B');
  assert.equal(await read(join(b.memory, copy)), 'B version\n');
  await a.check();
  assert.equal(await read(join(a.memory, copy)), 'B version\n');

  // A deletion on one PC reaches the other.
  await rm(join(a.memory, copy));
  await a.check();
  await b.check();
  assert.ok(!existsSync(join(b.memory, copy)));
});

test('a missing or newly chosen memory folder never deletes notes from GitHub', { skip: !hasGit }, async t => {
  const { makePc, remoteFiles } = await world(t);
  const a = await makePc('a');
  await note(a, 'one.md', '1\n');
  await note(a, 'two.md', '2\n');
  await a.on(sync => sync.connect());
  const notes = () => remoteFiles().filter(path => path.startsWith('memory/')).sort();
  assert.deepEqual(notes(), ['memory/one.md', 'memory/two.md']);

  // The folder disappears (an unplugged drive): a settings change still syncs, and the notes stay on GitHub.
  await rm(a.memory, { recursive: true });
  a.settings.models = ['changed'];
  await a.check();
  assert.equal(a.posted.error, undefined);
  assert.deepEqual(notes(), ['memory/one.md', 'memory/two.md']);

  // Memory is pointed at a new, empty folder: GitHub's notes come into it instead of being deleted.
  const fresh = join(a.memory, '..', 'fresh');
  await mkdir(fresh, { recursive: true });
  await writeFile(join(fresh, 'three.md'), '3\n');
  a.settings['memory.globalPath'] = fresh;
  a.memory = fresh;
  await a.check();
  assert.deepEqual(notes(), ['memory/one.md', 'memory/three.md', 'memory/two.md']);
  assert.deepEqual((await readdir(fresh)).sort(), ['one.md', 'three.md', 'two.md']);

  // A PC with no memory folder at all gets one of its own when GitHub has memory.
  const b = await makePc('b');
  delete b.settings['memory.globalPath'];
  await b.on(sync => sync.connect());
  assert.equal(b.posted.error, undefined);
  assert.ok(b.settings['memory.globalPath'].endsWith('adopted'));
  assert.deepEqual((await readdir(b.settings['memory.globalPath'])).sort(), ['one.md', 'three.md', 'two.md']);
});

test('cancelling the first-connect question leaves the PC unconnected and changes nothing', { skip: !hasGit }, async t => {
  const { makePc } = await world(t);
  const a = await makePc('a', { models: ['A'] });
  await a.on(sync => sync.connect());
  const b = await makePc('b', { models: ['B'] });
  answers.push(undefined);
  await b.on(sync => sync.connect());
  assert.equal(b.posted.connected, false);
  assert.match(b.posted.error, /cancelled/);
  assert.deepEqual(b.settings.models, ['B']);
});
