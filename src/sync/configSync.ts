import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/** `dsh.*` settings that travel with the config, read from and written to user settings only. */
export const SYNCED_SETTINGS = [
  'models', 'subagents', 'nameModel', 'reviewModel', 'mcpServers', 'accessibility',
  'features.activityRail', 'features.autoName', 'features.shareRules', 'features.editorContext', 'features.reduceMotion', 'features.reviewAgent',
  'updates.check', 'runtime.mirror',
] as const;

export const GIST_FILE = 'dsh-config.json';
export const GIST_DESCRIPTION = 'DSH-IDE config (synced by DSH-IDE; API keys and MCP secrets are not included)';

export interface SyncRoots { dshHome: string; agentsHome: string; toolpacks: string }
export interface SyncFile { data: string; encoding?: 'base64' }
export interface ConfigBundle {
  format: 'dsh-config';
  version: 1;
  settings: Record<string, unknown>;
  /** Keyed by `dsh/AGENTS.md`, `dsh/skills/...` or `agents/skills/...`. */
  files: Record<string, SyncFile>;
  toolpacks: Record<string, { enabled: boolean; source: string }>;
}
export interface AccountRef { id: string; provider: string; label: string }

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 2000;
const MAX_DEPTH = 8;
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__']);
const PACK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** JSON with sorted keys and without undefined members, so equal configs hash equally. */
export function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(entry => entry === undefined ? null : sort(entry));
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.keys(item).sort().filter(key => (item as Record<string, unknown>)[key] !== undefined)
      .map(key => [key, sort((item as Record<string, unknown>)[key])]));
  };
  return JSON.stringify(sort(value));
}

export function hashBundle(bundle: ConfigBundle): string {
  return createHash('sha256').update(stableJson(bundle)).digest('hex');
}

export function serializeBundle(bundle: ConfigBundle): string {
  return JSON.stringify(JSON.parse(stableJson(bundle)), null, 2) + '\n';
}

export function parseBundle(text: string): ConfigBundle {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('The GitHub config is not valid JSON.'); }
  const bundle = value as Partial<ConfigBundle> | null;
  if (!bundle || bundle.format !== 'dsh-config') throw new Error('The GitHub config is not a DSH config.');
  if (bundle.version !== 1) throw new Error(`The GitHub config uses version ${String(bundle.version)}; update DSH-IDE to read it.`);
  const record = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item);
  if (!record(bundle.settings) || !record(bundle.files) || !record(bundle.toolpacks)) throw new Error('The GitHub config is incomplete.');
  for (const [path, file] of Object.entries(bundle.files)) {
    if (!record(file) || typeof file.data !== 'string' || (file.encoding !== undefined && file.encoding !== 'base64')) throw new Error(`The GitHub config has an invalid file: ${path}`);
    syncPath({ dshHome: '/d', agentsHome: '/a', toolpacks: '/t' }, path);
  }
  for (const [id, pack] of Object.entries(bundle.toolpacks)) {
    if (!PACK_ID.test(id) || !record(pack) || typeof pack.source !== 'string' || typeof pack.enabled !== 'boolean') throw new Error(`The GitHub config has an invalid toolpack: ${id}`);
  }
  return bundle as ConfigBundle;
}

/** Maps a bundle path to an absolute path, rejecting anything outside the synced locations. */
export function syncPath(roots: SyncRoots, path: string): string {
  const parts = path.split('/');
  const bad = (): never => { throw new Error(`Refusing to sync unexpected path: ${path}`); };
  const root = parts[0] === 'dsh' ? roots.dshHome : parts[0] === 'agents' ? roots.agentsHome : bad();
  const isRules = parts[0] === 'dsh' && parts.length === 2 && parts[1] === 'AGENTS.md';
  if (!isRules && (parts[1] !== 'skills' || parts.length < 4)) bad();
  for (const part of parts.slice(1)) {
    if (!part || part.startsWith('.') || SKIPPED_DIRS.has(part) || /[\\:*?"<>|\0]/.test(part)) bad();
  }
  const file = resolve(root, ...parts.slice(1));
  if (!file.startsWith(resolve(root) + sep)) bad();
  return file;
}

function encode(buffer: Buffer): SyncFile {
  const text = buffer.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buffer) ? { data: text } : { data: buffer.toString('base64'), encoding: 'base64' };
}

const decode = (file: SyncFile): Buffer => file.encoding === 'base64' ? Buffer.from(file.data, 'base64') : Buffer.from(file.data, 'utf8');

/** Global rules and skills on this PC, keyed like `ConfigBundle.files`. */
export async function collectFiles(roots: SyncRoots): Promise<Record<string, SyncFile>> {
  const files: Record<string, SyncFile> = {};
  let count = 0;
  let bytes = 0;
  const add = async (path: string, file: string): Promise<void> => {
    const buffer = await fs.readFile(file);
    if (buffer.length > MAX_FILE_BYTES) throw new Error(`${path} is larger than 1 MB, so it cannot be synced.`);
    bytes += buffer.length;
    if (++count > MAX_FILES || bytes > MAX_TOTAL_BYTES) throw new Error('Rules and skills are too large to sync (limit 2000 files or 20 MB).');
    files[path] = encode(buffer);
  };
  const walk = async (directory: string, path: string, depth: number): Promise<void> => {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name) || /[\\:*?"<>|]/.test(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) { if (depth < MAX_DEPTH) await walk(full, `${path}/${entry.name}`, depth + 1); }
      else if (entry.isFile() && depth > 0) await add(`${path}/${entry.name}`, full);
    }
  };
  try {
    if ((await fs.lstat(join(roots.dshHome, 'AGENTS.md'))).isFile()) await add('dsh/AGENTS.md', join(roots.dshHome, 'AGENTS.md'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await walk(join(roots.dshHome, 'skills'), 'dsh/skills', 0);
  await walk(join(roots.agentsHome, 'skills'), 'agents/skills', 0);
  return files;
}

/** Makes this PC's global rules and skills match `files`: writes changed files and deletes ones the bundle lacks. */
export async function applyFiles(roots: SyncRoots, files: Record<string, SyncFile>): Promise<void> {
  const targets = Object.keys(files).map(path => [path, syncPath(roots, path)] as const);
  const local = await collectFiles(roots);
  for (const path of Object.keys(local)) {
    if (Object.hasOwn(files, path)) continue;
    const file = syncPath(roots, path);
    await fs.rm(file, { force: true });
    // Prune folders the deletion emptied, stopping at the skills root.
    const stop = resolve(path.startsWith('dsh/') ? roots.dshHome : roots.agentsHome, 'skills');
    for (let folder = dirname(file); folder.startsWith(stop + sep); folder = dirname(folder)) {
      try { await fs.rmdir(folder); } catch { break; }
    }
  }
  for (const [path, file] of targets) {
    const data = decode(files[path]);
    if (local[path] && decode(local[path]).equals(data)) continue;
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  }
}

/** Uploaded toolpack sources and their on/off state. Runtime `data` folders stay local. */
export async function collectToolpacks(dir: string): Promise<ConfigBundle['toolpacks']> {
  const packs: ConfigBundle['toolpacks'] = {};
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return packs; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || !PACK_ID.test(entry.name)) continue;
    try {
      const source = await fs.readFile(join(dir, entry.name, 'pack.ts'), 'utf8');
      let enabled = true;
      try { enabled = (JSON.parse(await fs.readFile(join(dir, entry.name, 'meta.json'), 'utf8')) as { enabled?: unknown }).enabled !== false; }
      catch { /* missing meta means enabled, as in the registry */ }
      packs[entry.name] = { enabled, source };
    } catch { /* not a complete toolpack */ }
  }
  return packs;
}

type Pair = { name?: unknown; value?: unknown };
const pairs = (value: unknown): Pair[] | undefined => Array.isArray(value) ? value.filter((item): item is Pair => !!item && typeof item === 'object') : undefined;

/** Blanks MCP `env` and `headers` values, which commonly hold API keys. */
export function stripMcpSecrets(servers: unknown): unknown {
  if (!Array.isArray(servers)) return servers;
  const blank = (value: unknown): unknown => {
    const list = pairs(value);
    if (list) return list.map(item => ({ ...item, value: '' }));
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).map(key => [key, '']));
    return value;
  };
  return servers.map(server => {
    if (!server || typeof server !== 'object') return server;
    const next = { ...(server as Record<string, unknown>) };
    if (next.env !== undefined) next.env = blank(next.env);
    if (next.headers !== undefined) next.headers = blank(next.headers);
    return next;
  });
}

/** Refills blanked MCP secrets from this PC's servers with the same name. */
export function restoreMcpSecrets(remote: unknown, local: unknown): unknown {
  if (!Array.isArray(remote)) return remote;
  const locals = new Map((Array.isArray(local) ? local : []).filter(item => item && typeof item === 'object' && typeof item.name === 'string')
    .map(item => [item.name as string, item as Record<string, unknown>]));
  const fill = (value: unknown, previous: unknown): unknown => {
    const list = pairs(value);
    if (list) {
      const old = new Map((pairs(previous) || []).map(item => [item.name, item.value]));
      return list.map(item => item.value === '' && old.has(item.name) ? { ...item, value: old.get(item.name) } : item);
    }
    if (value && typeof value === 'object' && previous && typeof previous === 'object' && !Array.isArray(previous)) {
      const old = previous as Record<string, unknown>;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item === '' && Object.hasOwn(old, key) ? old[key] : item]));
    }
    return value;
  };
  return remote.map(server => {
    if (!server || typeof server !== 'object') return server;
    const next = { ...(server as Record<string, unknown>) };
    const previous = typeof next.name === 'string' ? locals.get(next.name) : undefined;
    if (!previous) return next;
    if (next.env !== undefined) next.env = fill(next.env, previous.env);
    if (next.headers !== undefined) next.headers = fill(next.headers, previous.headers);
    return next;
  });
}

/** Account ids are per-PC, so models carry the account's label instead. */
export function portableModels(models: unknown, accounts: AccountRef[]): unknown {
  if (!Array.isArray(models)) return models;
  return models.map(model => {
    if (!model || typeof model !== 'object') return model;
    const { account, ...rest } = model as Record<string, unknown>;
    const found = typeof account === 'string' && account !== 'default' ? accounts.find(item => item.id === account) : undefined;
    return found ? { ...rest, accountLabel: found.label } : model;
  });
}

/** Resolves `accountLabel` to an account on this PC with the same provider and label, else the provider default. */
export function localModels(models: unknown, accounts: AccountRef[]): unknown {
  if (!Array.isArray(models)) return models;
  return models.map(model => {
    if (!model || typeof model !== 'object' || !('accountLabel' in model)) return model;
    const { accountLabel, ...rest } = model as Record<string, unknown>;
    const found = accounts.find(item => item.provider === rest.provider && item.label === accountLabel);
    return { ...rest, account: found?.id || 'default' };
  });
}

export interface GistInfo { id: string; url: string; updatedAt: string }
type Fetch = typeof fetch;
const API = 'https://api.github.com';

async function github(token: string, path: string, init: RequestInit = {}, fetchImpl: Fetch = fetch): Promise<Response> {
  return fetchImpl(`${API}${path}`, {
    ...init,
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'dsh-ide', ...(init.body ? { 'content-type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(20_000),
  });
}

async function failure(response: Response, action: string): Promise<Error> {
  let detail = '';
  try { detail = String(((await response.json()) as { message?: unknown }).message || ''); } catch { /* no body */ }
  return new Error(`GitHub ${action} failed (HTTP ${response.status}${detail ? `: ${detail}` : ''}).`);
}

const info = (gist: Record<string, unknown>): GistInfo => ({ id: String(gist.id), url: String(gist.html_url), updatedAt: String(gist.updated_at) });

/** Finds the signed-in user's DSH config gist, if one exists. */
export async function findConfigGist(token: string, fetchImpl: Fetch = fetch): Promise<GistInfo | undefined> {
  for (let page = 1; page <= 10; page++) {
    const response = await github(token, `/gists?per_page=100&page=${page}`, {}, fetchImpl);
    if (!response.ok) throw await failure(response, 'gist lookup');
    const gists = await response.json() as Record<string, unknown>[];
    const found = gists.find(gist => gist.files && typeof gist.files === 'object' && Object.hasOwn(gist.files, GIST_FILE)
      && typeof gist.description === 'string' && gist.description.startsWith('DSH-IDE config'));
    if (found) return info(found);
    if (gists.length < 100) return undefined;
  }
  return undefined;
}

/** Reads the config from a gist. Returns undefined when the gist no longer exists. */
export async function readConfigGist(token: string, id: string, fetchImpl: Fetch = fetch): Promise<{ gist: GistInfo; bundle: ConfigBundle } | undefined> {
  const response = await github(token, `/gists/${encodeURIComponent(id)}`, {}, fetchImpl);
  if (response.status === 404) return undefined;
  if (!response.ok) throw await failure(response, 'gist download');
  const gist = await response.json() as Record<string, unknown>;
  const file = (gist.files as Record<string, { content?: unknown; truncated?: unknown; raw_url?: unknown }> | undefined)?.[GIST_FILE];
  if (!file) throw new Error(`The gist has no ${GIST_FILE}.`);
  let content = typeof file.content === 'string' ? file.content : '';
  if (file.truncated) {
    // Files over 1 MB are truncated in API responses; the raw URL has the full text.
    const raw = new URL(String(file.raw_url));
    if (raw.protocol !== 'https:' || raw.hostname !== 'gist.githubusercontent.com') throw new Error('Unexpected gist download address.');
    const full = await fetchImpl(raw.href, { signal: AbortSignal.timeout(20_000) });
    if (!full.ok) throw await failure(full, 'gist download');
    content = await full.text();
  }
  return { gist: info(gist), bundle: parseBundle(content) };
}

/** Creates a secret gist, or updates `id`. Returns undefined when `id` no longer exists. */
export async function writeConfigGist(token: string, id: string | undefined, bundle: ConfigBundle, fetchImpl: Fetch = fetch): Promise<GistInfo | undefined> {
  const body = JSON.stringify({ description: GIST_DESCRIPTION, ...(id ? {} : { public: false }), files: { [GIST_FILE]: { content: serializeBundle(bundle) } } });
  const response = await github(token, id ? `/gists/${encodeURIComponent(id)}` : '/gists', { method: id ? 'PATCH' : 'POST', body }, fetchImpl);
  if (id && response.status === 404) return undefined;
  if (!response.ok) throw await failure(response, 'gist upload');
  return info(await response.json() as Record<string, unknown>);
}
