import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyFiles, collectFiles, collectToolpacks, findConfigGist, hashBundle, localModels, parseBundle, portableModels,
  readConfigGist, restoreMcpSecrets, serializeBundle, stripMcpSecrets, syncPath, writeConfigGist, GIST_FILE,
} from '../dist/sync/configSync.mjs';

const exists = path => access(path).then(() => true, () => false);

async function roots(t) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-sync-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  return { dshHome: join(base, 'dsh'), agentsHome: join(base, 'agents'), toolpacks: join(base, 'toolpacks') };
}

async function put(file, text) {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, text);
}

const bundle = (files = {}, settings = {}, toolpacks = {}) => ({ format: 'dsh-config', version: 1, settings, files, toolpacks });

test('collects global rules and skills, skipping hidden and bundled folders', async t => {
  const r = await roots(t);
  await put(join(r.dshHome, 'AGENTS.md'), '# Rules');
  await put(join(r.dshHome, 'skills', 'alpha', 'SKILL.md'), 'alpha');
  await put(join(r.dshHome, 'skills', 'alpha', 'refs', 'notes.md'), 'notes');
  await put(join(r.dshHome, 'skills', '.system', 'builtin', 'SKILL.md'), 'builtin');
  await put(join(r.dshHome, 'skills', 'loose.md'), 'not in a skill folder');
  await put(join(r.agentsHome, 'skills', 'beta', 'SKILL.md'), 'beta');
  await put(join(r.agentsHome, 'skills', 'beta', 'icon.bin'), Buffer.from([0xff, 0x00, 0xfe]));
  await put(join(r.dshHome, 'sessions', 'log.json'), '{}');
  const files = await collectFiles(r);
  assert.deepEqual(Object.keys(files).sort(), ['agents/skills/beta/SKILL.md', 'agents/skills/beta/icon.bin', 'dsh/AGENTS.md', 'dsh/skills/alpha/SKILL.md', 'dsh/skills/alpha/refs/notes.md']);
  assert.deepEqual(files['dsh/AGENTS.md'], { data: '# Rules' });
  assert.deepEqual(files['agents/skills/beta/icon.bin'], { data: Buffer.from([0xff, 0x00, 0xfe]).toString('base64'), encoding: 'base64' });
});

test('applying files writes, updates and deletes only synced paths', async t => {
  const source = await roots(t);
  await put(join(source.dshHome, 'AGENTS.md'), 'remote rules');
  await put(join(source.agentsHome, 'skills', 'keep', 'SKILL.md'), 'remote keep');
  await put(join(source.agentsHome, 'skills', 'new', 'SKILL.md'), 'new skill');
  const remote = await collectFiles(source);

  const target = await roots(t);
  await put(join(target.dshHome, 'AGENTS.md'), 'local rules');
  await put(join(target.agentsHome, 'skills', 'keep', 'SKILL.md'), 'local keep');
  await put(join(target.agentsHome, 'skills', 'gone', 'SKILL.md'), 'deleted elsewhere');
  await put(join(target.dshHome, 'skills', '.system', 'builtin', 'SKILL.md'), 'builtin');
  await put(join(target.dshHome, 'config.json'), '{}');
  await applyFiles(target, remote);

  assert.equal(await readFile(join(target.dshHome, 'AGENTS.md'), 'utf8'), 'remote rules');
  assert.equal(await readFile(join(target.agentsHome, 'skills', 'keep', 'SKILL.md'), 'utf8'), 'remote keep');
  assert.equal(await readFile(join(target.agentsHome, 'skills', 'new', 'SKILL.md'), 'utf8'), 'new skill');
  assert.equal(await exists(join(target.agentsHome, 'skills', 'gone')), false, 'emptied skill folder is pruned');
  assert.equal(await exists(join(target.agentsHome, 'skills')), true, 'skills root is kept');
  assert.equal(await exists(join(target.dshHome, 'skills', '.system', 'builtin', 'SKILL.md')), true);
  assert.equal(await exists(join(target.dshHome, 'config.json')), true);
  assert.equal(hashBundle(bundle(await collectFiles(target))), hashBundle(bundle(remote)));
});

test('rejects paths outside the synced folders', () => {
  const r = { dshHome: join(tmpdir(), 'd'), agentsHome: join(tmpdir(), 'a'), toolpacks: join(tmpdir(), 't') };
  for (const path of ['dsh/config.json', 'dsh/skills/../x/SKILL.md', 'agents/AGENTS.md', 'other/skills/a/SKILL.md', 'dsh/skills/.system/a/SKILL.md', 'dsh/skills/a/C:x', 'dsh/skills/x.md', 'dsh/skills//SKILL.md']) {
    assert.throws(() => syncPath(r, path), /unexpected path/, path);
  }
  assert.equal(syncPath(r, 'agents/skills/a/SKILL.md'), join(r.agentsHome, 'skills', 'a', 'SKILL.md'));
  assert.throws(() => parseBundle(JSON.stringify(bundle({ 'dsh/../../evil': { data: '' } }))), /unexpected path/);
});

test('bundles parse back and hash independently of key order', () => {
  const a = bundle({ 'dsh/AGENTS.md': { data: 'x' } }, { 'features.autoName': false, models: [{ name: 'M', provider: 'p', backend: 'b' }] });
  const b = { toolpacks: {}, files: a.files, settings: { models: [{ backend: 'b', provider: 'p', name: 'M' }], 'features.autoName': false }, version: 1, format: 'dsh-config' };
  assert.equal(hashBundle(a), hashBundle(b));
  assert.deepEqual(parseBundle(serializeBundle(a)), JSON.parse(serializeBundle(b)));
  assert.throws(() => parseBundle('{"format":"dsh-config","version":2,"settings":{},"files":{},"toolpacks":{}}'), /version 2/);
  assert.throws(() => parseBundle('nope'), /not valid JSON/);
});

test('reads toolpack sources and their on/off state', async t => {
  const r = await roots(t);
  await put(join(r.toolpacks, 'echo', 'pack.ts'), 'export default {}');
  await put(join(r.toolpacks, 'echo', 'meta.json'), JSON.stringify({ description: 'Echo', enabled: false }));
  await put(join(r.toolpacks, 'echo', 'data', 'secret.txt'), 'runtime data');
  await put(join(r.toolpacks, '.staging-1', 'pack.ts'), 'partial');
  assert.deepEqual(await collectToolpacks(r.toolpacks), { echo: { enabled: false, source: 'export default {}' } });
});

test('MCP env and header values are blanked on upload and refilled on download', () => {
  const local = [
    { name: 'search', command: 'node', args: ['s.js'], env: [{ name: 'API_KEY', value: 'secret' }, { name: 'MODE', value: 'fast' }] },
    { type: 'http', name: 'web', url: 'https://x.test/mcp', headers: [{ name: 'Authorization', value: 'Bearer t' }] },
  ];
  const uploaded = stripMcpSecrets(local);
  assert.equal(JSON.stringify(uploaded).includes('secret'), false);
  assert.equal(JSON.stringify(uploaded).includes('Bearer'), false);
  assert.deepEqual(uploaded[0].env, [{ name: 'API_KEY', value: '' }, { name: 'MODE', value: '' }]);
  const remote = [...uploaded, { name: 'fresh', command: 'x', env: [{ name: 'TOKEN', value: '' }] }];
  assert.deepEqual(restoreMcpSecrets(remote, local), [...local, remote[2]]);
});

test('models carry account labels across PCs', () => {
  const here = [{ id: 'acct-1', provider: 'deepseek-official', label: 'Work' }];
  const there = [{ id: 'acct-9', provider: 'deepseek-official', label: 'Work' }];
  const models = [
    { name: 'A', provider: 'deepseek-official', backend: 'x', account: 'acct-1' },
    { name: 'B', provider: 'deepseek-official', backend: 'y', account: 'default' },
  ];
  const portable = portableModels(models, here);
  assert.deepEqual(portable[0], { name: 'A', provider: 'deepseek-official', backend: 'x', accountLabel: 'Work' });
  assert.deepEqual(portable[1], models[1]);
  assert.equal(localModels(portable, there)[0].account, 'acct-9');
  assert.equal(localModels(portable, [])[0].account, 'default');
  assert.equal('accountLabel' in localModels(portable, [])[0], false);
});

function fakeGitHub() {
  const gists = new Map();
  const calls = [];
  let next = 1;
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const view = gist => ({ id: gist.id, html_url: `https://gist.github.com/me/${gist.id}`, updated_at: '2026-10-05T00:00:00Z', description: gist.description, files: gist.files });
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', auth: init.headers?.authorization });
    const path = new URL(url).pathname;
    if (path === '/gists' && (init.method || 'GET') === 'GET') return json(200, [{ id: 'other', description: 'unrelated', files: { 'a.txt': {} } }, ...[...gists.values()].map(view)]);
    if (path === '/gists' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      assert.equal(body.public, false);
      const gist = { id: `g${next++}`, description: body.description, files: Object.fromEntries(Object.entries(body.files).map(([name, file]) => [name, { content: file.content }])) };
      gists.set(gist.id, gist);
      return json(201, view(gist));
    }
    const id = path.split('/')[2];
    const gist = gists.get(id);
    if (!gist) return json(404, { message: 'Not Found' });
    if (init.method === 'PATCH') {
      const body = JSON.parse(init.body);
      for (const [name, file] of Object.entries(body.files)) gist.files[name] = { content: file.content };
    }
    return json(200, view(gist));
  };
  return { gists, calls, fetchImpl };
}

test('creates, finds, reads and updates the config gist', async () => {
  const github = fakeGitHub();
  assert.equal(await findConfigGist('tok', github.fetchImpl), undefined);
  const first = bundle({ 'dsh/AGENTS.md': { data: 'one' } });
  const created = await writeConfigGist('tok', undefined, first, github.fetchImpl);
  assert.equal(created.url, `https://gist.github.com/me/${created.id}`);
  assert.equal((await findConfigGist('tok', github.fetchImpl)).id, created.id);
  assert.equal(hashBundle((await readConfigGist('tok', created.id, github.fetchImpl)).bundle), hashBundle(first));
  const second = bundle({ 'dsh/AGENTS.md': { data: 'two' } });
  assert.equal((await writeConfigGist('tok', created.id, second, github.fetchImpl)).id, created.id);
  assert.equal(hashBundle((await readConfigGist('tok', created.id, github.fetchImpl)).bundle), hashBundle(second));
  assert.ok(github.gists.get(created.id).files[GIST_FILE]);
  assert.equal(await readConfigGist('tok', 'missing', github.fetchImpl), undefined);
  assert.equal(await writeConfigGist('tok', 'missing', second, github.fetchImpl), undefined);
  assert.ok(github.calls.every(call => call.url.startsWith('https://api.github.com/') && call.auth === 'Bearer tok'));
});

test('reports GitHub errors with their message', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
  await assert.rejects(findConfigGist('bad', fetchImpl), /HTTP 401: Bad credentials/);
});
