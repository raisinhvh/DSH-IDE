import { createHash } from 'node:crypto';
import { existsSync, promises as fs, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Memory: the user's knowledge vaults (Markdown notes, conventions, scripts), presented to agents as ordinary
 * folders in the working copy so every runtime can search, read and edit them with its own tools.
 *
 * The global vault lives anywhere on this PC. Each turn it is reconciled with a copy at GLOBAL_MEMORY_DIR in the
 * working copy: changes made on either side since the last sync are carried to the other, so notes an agent writes
 * reach the real folder and every other project. DSH's review skips .dsh/, so these edits are not proposals.
 * The repo vault is ordinary repository content (DEFAULT_REPO_MEMORY unless configured) and is reviewed like code.
 */
export const GLOBAL_MEMORY_DIR = '.dsh/global-memory';
export const DEFAULT_REPO_MEMORY = '.dsh/memory';
const MANIFEST = '.dsh/global-memory.json';
const SKIP = new Set(['.git', '.obsidian', '.trash', 'node_modules', '.DS_Store', 'Thumbs.db']);
export const MAX_MEMORY_FILES = 5000;
export const MAX_MEMORY_BYTES = 50 * 1024 * 1024;
const INDEX_FILES = ['INDEX.md', 'index.md', 'README.md', 'Home.md', '_index.md'];

/** An absolute folder path from the setting, with a leading ~ expanded; undefined when unset or relative. */
export function globalMemoryRoot(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const raw = value.trim();
  const expanded = raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\') ? join(homedir(), raw.slice(1)) : raw;
  return isAbsolute(expanded) ? resolve(expanded) : undefined;
}

/** A repo vault path relative to the workspace, with forward slashes; undefined when it would leave the workspace. */
export function repoMemoryPath(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value.trim() : DEFAULT_REPO_MEMORY;
  if (!raw) return undefined;
  const path = raw.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!path || isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')) return undefined;
  return path;
}

/** Whether a working-copy-relative path lies in the global copy or the repo vault. */
export function isMemoryPath(rel: string, repoPath?: string): boolean {
  const path = rel.replaceAll('\\', '/').replace(/^\.\//, '');
  return [GLOBAL_MEMORY_DIR, repoPath].some(root => !!root && (path === root || path.startsWith(`${root}/`)));
}

const isDir = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };

/**
 * The one instruction line that tells the agent where memory is and what is worth saving; empty when there is none.
 * A repo vault that does not exist yet is offered only alongside a global one, so a project without memory costs nothing.
 */
export function memoryInstructions(cwd: string, repoPath?: string): string {
  const where = (path: string): string => {
    const index = INDEX_FILES.find(name => existsSync(join(cwd, path, name)));
    return `${path}/${index ? ` (start at ${index})` : ''}`;
  };
  const global = isDir(join(cwd, GLOBAL_MEMORY_DIR));
  const repo = !!repoPath && isDir(join(cwd, repoPath));
  if (!global && !repo) return '';
  const places = [
    global ? `global, for all projects, at ${where(GLOBAL_MEMORY_DIR)}` : '',
    repoPath ? `this repo at ${repo ? where(repoPath) : `${repoPath}/ (create it when needed)`}` : '',
  ].filter(Boolean).join('; ');
  const both = global && !!repoPath;
  return `Memory (the user's notes, conventions and scripts; [[name]] links a note): ${places}. Search it with your usual tools when a task may touch what it covers${both ? '; repo notes override global' : ''}. `
    + 'Save only what a future task could reuse: tools, conventions, decisions and why. Never one-off details (one model\'s attachment position). '
    + `${both ? 'Reusable anywhere goes global; project-specific goes in the repo. ' : ''}Update existing notes rather than adding near-duplicates.`;
}

interface Entry { hash: string; gSize?: number; gTime?: number; cSize?: number; cTime?: number }
interface Manifest { root: string; files: Record<string, Entry> }
export interface MemorySync { pulled: number; saved: string[]; conflicts: string[]; skipped?: string }
type Listing = Map<string, { size: number; time: number }>;

async function list(root: string): Promise<Listing> {
  const files: Listing = new Map();
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile()) continue;
      const info = await fs.stat(full);
      bytes += info.size;
      files.set(relative(root, full).split(sep).join('/'), { size: info.size, time: info.mtimeMs });
      if (files.size > MAX_MEMORY_FILES) throw new Error(`more than ${MAX_MEMORY_FILES} files`);
      if (bytes > MAX_MEMORY_BYTES) throw new Error(`more than ${MAX_MEMORY_BYTES / 1024 / 1024} MB`);
    }
  };
  await walk(root);
  return files;
}

const digest = async (path: string): Promise<string> => createHash('sha256').update(await fs.readFile(path)).digest('hex');

async function copy(from: string, to: string): Promise<void> {
  await fs.mkdir(dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}

/** "notes/a.md" becomes "notes/a (conflict 2026-11-04 1530).md". */
export function conflictName(rel: string, now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`;
  const ext = extname(rel);
  const dir = dirname(rel);
  const name = `${basename(rel, ext)} (conflict ${stamp})${ext}`;
  return dir === '.' ? name : `${dir}/${name}`;
}

/** Whether a sync has anything to do: a global vault is set, or a copy from an earlier one is left to remove. */
export function memorySyncNeeded(globalRoot: string | undefined, cwd: string): boolean {
  return !!globalRoot || existsSync(join(cwd, GLOBAL_MEMORY_DIR)) || existsSync(join(cwd, MANIFEST));
}

/** Keeps the copy's files out of git when the working copy is the user's real repository. */
async function excludeFromGit(cwd: string): Promise<void> {
  const file = join(cwd, '.git', 'info', 'exclude');
  if (!existsSync(dirname(file))) return;
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  const missing = [`/${GLOBAL_MEMORY_DIR}/`, `/${MANIFEST}`].filter(line => !text.split(/\r?\n/).includes(line));
  if (missing.length) await fs.appendFile(file, `${text && !text.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
}

/**
 * Reconciles the global vault with its copy in the working copy. A file changed on one side since the last sync is
 * carried to the other side (including deletions). When both sides changed it, the vault's version wins in the copy
 * and the agent's version is saved in the vault next to it as a conflict copy, so nothing is lost.
 */
export async function syncGlobalMemory(globalRoot: string | undefined, cwd: string): Promise<MemorySync> {
  const result: MemorySync = { pulled: 0, saved: [], conflicts: [] };
  const copyRoot = join(cwd, GLOBAL_MEMORY_DIR);
  const manifestPath = join(cwd, MANIFEST);
  if (!globalRoot) {
    // Nothing to do on most turns: memory is off and no copy is left over.
    if (!existsSync(copyRoot) && !existsSync(manifestPath)) return result;
    // Memory was turned off: remove the copy so agents do not read stale notes.
    await fs.rm(copyRoot, { recursive: true, force: true });
    await fs.rm(manifestPath, { force: true });
    return result;
  }
  if (!isDir(globalRoot)) return { ...result, skipped: `${globalRoot} is not a folder` };
  const rel = relative(globalRoot, cwd);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) return { ...result, skipped: 'the memory folder contains this workspace' };
  let manifest: Manifest = { root: globalRoot, files: {} };
  try {
    const saved = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Manifest;
    if (saved.root === globalRoot && saved.files && typeof saved.files === 'object') manifest = saved;
    else await fs.rm(copyRoot, { recursive: true, force: true });
  } catch { /* first sync */ }
  let vault: Listing, copied: Listing;
  try { [vault, copied] = await Promise.all([list(globalRoot), list(copyRoot)]); }
  catch (error) { return { ...result, skipped: `the memory folder has ${error instanceof Error ? error.message : String(error)}` }; }
  const files: Record<string, Entry> = {};
  for (const path of new Set([...vault.keys(), ...copied.keys(), ...Object.keys(manifest.files)])) {
    const known = manifest.files[path];
    const g = vault.get(path), c = copied.get(path);
    const gAt = join(globalRoot, ...path.split('/')), cAt = join(copyRoot, ...path.split('/'));
    // Unchanged size and time since the last sync means unchanged content, so most files are not read at all.
    const gHash = g ? (known && known.gSize === g.size && known.gTime === g.time ? known.hash : await digest(gAt)) : null;
    const cHash = c ? (known && known.cSize === c.size && known.cTime === c.time ? known.hash : await digest(cAt)) : null;
    const base = known?.hash ?? null;
    let hash: string | null;
    if (gHash === cHash) hash = gHash;
    else if (cHash === base) {
      if (gHash === null) await fs.rm(cAt, { force: true }); else await copy(gAt, cAt);
      result.pulled += 1;
      hash = gHash;
    } else if (gHash === base) {
      if (cHash === null) await fs.rm(gAt, { force: true }); else await copy(cAt, gAt);
      result.saved.push(path);
      hash = cHash;
    } else {
      if (cHash !== null) {
        const name = conflictName(path);
        await copy(cAt, join(globalRoot, ...name.split('/')));
        result.conflicts.push(name);
      }
      if (gHash === null) await fs.rm(cAt, { force: true }); else await copy(gAt, cAt);
      hash = gHash;
    }
    if (hash === null) continue;
    const [gStat, cStat] = await Promise.all([fs.stat(gAt).catch(() => undefined), fs.stat(cAt).catch(() => undefined)]);
    files[path] = { hash, gSize: gStat?.size, gTime: gStat?.mtimeMs, cSize: cStat?.size, cTime: cStat?.mtimeMs };
  }
  // Conflict copies were written to the vault this round; the next sync brings them into the copy.
  await fs.mkdir(copyRoot, { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify({ root: globalRoot, files } satisfies Manifest));
  await excludeFromGit(cwd).catch(() => undefined);
  return result;
}
