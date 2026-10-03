import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export type ShareProvider = 'claude-cli' | 'codex-cli';
export interface ShareRoots { dshHome: string; agentsHome: string }
export interface ShareResult { rules: boolean; skills: string[] }

const START = '<!-- dsh:shared-rules:start (managed by DSH-IDE; edit global rules in DSH instead) -->';
const END = '<!-- dsh:shared-rules:end -->';
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/i;
type Owned = Record<string, { fingerprint: string }>;

async function read(file: string): Promise<string | undefined> {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function rules(provider: ShareProvider, directory: string, roots: ShareRoots, enabled: boolean): Promise<boolean> {
  const file = join(directory, provider === 'claude-cli' ? 'CLAUDE.md' : 'AGENTS.md');
  const old = await read(file);
  const source = enabled ? await read(join(roots.dshHome, 'AGENTS.md')) : undefined;
  const body = source?.trimEnd();
  const block = body?.trim() ? `${START}\n${body}\n${END}` : '';
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escape(START)}\\r?\\n[\\s\\S]*?^${escape(END)}(?=\\r?$)`, 'm');
  const match = pattern.exec(old ?? '');
  let next = old ?? '';
  let onlyBlock = false;
  if (match) {
    const before = next.slice(0, match.index);
    const after = next.slice(match.index + match[0].length);
    onlyBlock = !(before + after).trim();
    next = block ? before + block + after : before.replace(/\r?\n\r?\n$/, '') + after;
  } else if (block) {
    // Own only the added separator; existing bytes remain untouched.
    next += (next ? '\n\n' : '') + block;
  }
  if (!block && match && onlyBlock && !next.trim()) await fs.unlink(file);
  else if (next !== (old ?? '')) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(file, next, 'utf8');
  }
  return !!block;
}

async function manifest(file: string): Promise<Owned> {
  try {
    const value = JSON.parse((await read(file)) ?? 'null');
    if (value?.version !== 1 || !value.skills || typeof value.skills !== 'object' || Array.isArray(value.skills)) return {};
    const entries = Object.entries(value.skills);
    if (entries.some(([name, item]) => !NAME.test(name) || !item || typeof (item as { fingerprint?: unknown }).fingerprint !== 'string')) return {};
    return Object.fromEntries(entries) as Owned;
  } catch { return {}; }
}

async function directoryExists(path: string): Promise<boolean> {
  try { return (await fs.lstat(path)).isDirectory(); }
  catch { return false; }
}

async function scan(root: string): Promise<{ files: string[]; directories: string[]; fingerprint: string }> {
  const files: string[] = [];
  const directories: string[] = [];
  const stamps: string[] = [];
  let bytes = 0;
  async function walk(rel: string): Promise<void> {
    const entries = await fs.readdir(join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      const stat = await fs.lstat(join(root, path));
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        directories.push(path);
        await walk(path);
      } else if (stat.isFile()) {
        files.push(path);
        bytes += stat.size;
        if (files.length > 200 || bytes > 5 * 1024 * 1024) throw new Error('Skill exceeds sharing limits.');
        stamps.push(`${path}:${stat.size}:${stat.mtimeMs}`);
      }
    }
  }
  await walk('');
  return { files, directories, fingerprint: createHash('sha256').update(stamps.sort().join('\n')).digest('hex') };
}

async function skills(provider: ShareProvider, directory: string, roots: ShareRoots, enabled: boolean): Promise<string[]> {
  const target = join(directory, 'skills');
  try {
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return [];
  }
  const file = join(target, '.dsh-shared.json');
  const owned = await manifest(file);
  const original = JSON.stringify(owned);
  const sources = new Map<string, string>();
  if (enabled) {
    const homes = provider === 'claude-cli' ? [roots.agentsHome, roots.dshHome] : [roots.dshHome];
    for (const home of homes) {
      const root = join(home, 'skills');
      if (!await directoryExists(root)) continue;
      try {
        for (const entry of await fs.readdir(root, { withFileTypes: true })) {
          if (!NAME.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink() || sources.has(entry.name)) continue;
          const source = join(root, entry.name);
          try {
            if ((await fs.lstat(join(source, 'SKILL.md'))).isFile()) sources.set(entry.name, source);
          } catch { /* ignore incomplete skills */ }
        }
      } catch { /* another source root can still be shared */ }
    }
  }
  for (const name of Object.keys(owned)) {
    if (sources.has(name)) continue;
    try {
      await fs.rm(join(target, name), { recursive: true, force: true });
      delete owned[name];
    } catch { /* retain ownership so cleanup can retry */ }
  }
  for (const [name, source] of sources) {
    const destination = join(target, name);
    try {
      let exists = false;
      try { await fs.lstat(destination); exists = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (exists && !Object.hasOwn(owned, name)) continue;
      const snapshot = await scan(source);
      if (exists && owned[name]?.fingerprint === snapshot.fingerprint) continue;
      if (exists) await fs.rm(destination, { recursive: true, force: true });
      await fs.mkdir(destination, { recursive: true });
      owned[name] = { fingerprint: '' };
      for (const rel of snapshot.directories) await fs.mkdir(join(destination, rel), { recursive: true });
      for (const rel of snapshot.files) await fs.copyFile(join(source, rel), join(destination, rel));
      owned[name] = { fingerprint: snapshot.fingerprint };
    } catch { /* errors in one skill must not interrupt other skills */ }
  }
  const names = Object.keys(owned).sort();
  try {
    if (!names.length) await fs.rm(file, { force: true });
    else if (JSON.stringify(owned) !== original) {
      await fs.writeFile(file, JSON.stringify({ version: 1, skills: owned }, null, 2) + '\n', 'utf8');
    }
  } catch { /* sharing remains best effort */ }
  const present: string[] = [];
  for (const name of names) if (await directoryExists(join(target, name))) present.push(name);
  return present;
}

/** Shares global instructions into the CLI's private account directory. */
export async function shareInstructions(provider: ShareProvider, directory: string, roots: ShareRoots, enabled: boolean): Promise<ShareResult> {
  let sharedRules = false;
  let rulesError: unknown;
  try { sharedRules = await rules(provider, directory, roots, enabled); }
  catch (error) { rulesError = error; }
  let sharedSkills: string[] = [];
  try { sharedSkills = await skills(provider, directory, roots, enabled); }
  catch { /* only rules failures propagate to the caller */ }
  if (rulesError) throw rulesError;
  return { rules: sharedRules, skills: sharedSkills };
}
