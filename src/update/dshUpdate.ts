import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { terminateProcessTree } from '../runtime/cancellation';
import { compareVersions, isVersion } from './version';

const PACKAGE = '@deepseek-ai/dsh';
const READY = '.dsh-ready';
// Large tarballs log nothing until they finish, so only a long silence counts as a stall.
const STALL_TIMEOUT_MS = 5 * 60_000;
const TOTAL_TIMEOUT_MS = 15 * 60_000;
const ABANDONED_MS = 60 * 60_000;

async function versionAt(packageJson: string): Promise<string | undefined> {
  try {
    const version = (JSON.parse(await readFile(packageJson, 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' && isVersion(version) ? version : undefined;
  } catch { return undefined; }
}

const updateRoot = (storage: string): string => join(storage, 'dsh-runtime');
const packageJsonIn = (root: string): string => join(root, 'node_modules', ...PACKAGE.split('/'), 'package.json');

interface Installed { root: string; version: string }

/** Each release lives in its own folder, so installing never touches files a running runtime has loaded. */
async function installedReleases(storage: string): Promise<Installed[]> {
  const base = updateRoot(storage);
  const found: Installed[] = [];
  // Releases installed before versioned folders existed.
  const legacy = await versionAt(packageJsonIn(base));
  if (legacy) found.push({ root: base, version: legacy });
  let entries: string[] = [];
  try { entries = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name !== 'node_modules').map(entry => entry.name); }
  catch { return found; }
  await Promise.all(entries.map(async name => {
    const root = join(base, name);
    const version = await versionAt(packageJsonIn(root));
    const ready = await readFile(join(root, READY), 'utf8').catch(() => undefined);
    if (version && ready?.trim() === version) found.push({ root, version });
  }));
  return found.sort((a, b) => compareVersions(b.version, a.version));
}

export async function bundledVersion(): Promise<string | undefined> {
  return versionAt(require.resolve(`${PACKAGE}/package.json`));
}

async function newestUpdate(storage: string): Promise<Installed | undefined> {
  const [newest] = await installedReleases(storage);
  if (!newest) return undefined;
  const bundled = await bundledVersion();
  return !bundled || compareVersions(newest.version, bundled) > 0 ? newest : undefined;
}

/** The folder whose node_modules DSH should load from: a downloaded update when it is newer than the bundled copy. */
export async function updatedRoot(storage: string): Promise<string | undefined> {
  return (await newestUpdate(storage))?.root;
}

export async function currentVersion(storage: string): Promise<string | undefined> {
  return (await newestUpdate(storage))?.version ?? bundledVersion();
}

export async function latestVersion(): Promise<string | undefined> {
  const response = await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}.`);
  const version = (await response.json() as { version?: unknown }).version;
  return typeof version === 'string' && isVersion(version) ? version : undefined;
}

/** Keeps the new release and the one before it (another window may still run it); removes older and abandoned folders. */
async function pruneReleases(storage: string, keep: string): Promise<void> {
  const base = updateRoot(storage);
  const releases = await installedReleases(storage);
  const kept = new Set([keep, ...releases.filter(release => release.root !== keep).slice(0, 1).map(release => release.root)]);
  const ready = new Set(releases.map(release => release.root));
  let entries: string[] = [];
  try { entries = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name !== 'node_modules').map(entry => entry.name); }
  catch { return; }
  for (const name of entries) {
    const root = join(base, name);
    if (kept.has(root)) continue;
    if (!ready.has(root)) {
      // Possibly another window's install in progress.
      const age = await stat(root).then(info => Date.now() - info.mtimeMs).catch(() => 0);
      if (age < ABANDONED_MS) continue;
    }
    // Drop the marker first so a partly removed folder is never selected.
    await rm(join(root, READY), { force: true }).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Installs a DSH release into extension storage with the npm that ships beside `node`. */
export function installVersion(storage: string, version: string, node: string, onProgress?: (downloads: number) => void): Promise<void> {
  if (!isVersion(version)) return Promise.reject(new Error('Unexpected DSH version.'));
  return (async () => {
    const root = join(updateRoot(storage), `${version}~${Date.now().toString(36)}`);
    await mkdir(root, { recursive: true });
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dsh-runtime', private: true }), 'utf8');
      const npm = join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      await new Promise<void>((resolve, reject) => {
        // --prefer-online: a just-published version may be missing from npm's cached metadata.
        const child = spawn(node, [npm, 'install', `${PACKAGE}@${version}`, '--prefer-online', '--no-audit', '--no-fund', '--loglevel=http'],
          { cwd: root, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdin.end();
        let output = '', downloads = 0, done = false, stall: NodeJS.Timeout | undefined;
        const finish = (error?: Error) => {
          if (done) return;
          done = true; clearTimeout(stall); clearTimeout(total);
          if (error) { terminateProcessTree(child); reject(error); } else resolve();
        };
        const arm = () => { clearTimeout(stall); stall = setTimeout(() => finish(new Error('npm stopped making progress.')), STALL_TIMEOUT_MS); };
        const total = setTimeout(() => finish(new Error('npm took too long.')), TOTAL_TIMEOUT_MS);
        arm();
        child.stdout.on('data', arm);
        child.stderr.on('data', (chunk: Buffer) => {
          arm();
          const before = downloads;
          for (const line of chunk.toString().split(/\r?\n/)) {
            if (/^npm http fetch /.test(line)) { downloads += 1; continue; }
            if (line.trim()) output = `${output}${line}\n`.slice(-1500);
          }
          if (downloads !== before) onProgress?.(downloads);
        });
        child.on('error', error => finish(error));
        child.on('close', code => finish(code === 0 ? undefined : new Error(output.trim() || `npm exited with code ${code}.`)));
      });
      if ((await versionAt(packageJsonIn(root))) !== version) throw new Error('The downloaded DSH could not be verified.');
      await writeFile(join(root, READY), version, 'utf8');
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    await pruneReleases(storage, root).catch(() => undefined);
  })();
}

export const dshBinFrom = (root: string | undefined): string =>
  require.resolve(`${PACKAGE}/lib/bin.js`, root ? { paths: [root] } : undefined);
