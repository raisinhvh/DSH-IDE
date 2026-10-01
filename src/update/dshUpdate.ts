import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareVersions, isVersion } from './version';

const PACKAGE = '@deepseek-ai/dsh';

async function versionAt(packageJson: string): Promise<string | undefined> {
  try {
    const version = (JSON.parse(await readFile(packageJson, 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' && isVersion(version) ? version : undefined;
  } catch { return undefined; }
}

const updateRoot = (storage: string): string => join(storage, 'dsh-runtime');
const updatedPackageJson = (storage: string): string => join(updateRoot(storage), 'node_modules', ...PACKAGE.split('/'), 'package.json');

export async function bundledVersion(): Promise<string | undefined> {
  return versionAt(require.resolve(`${PACKAGE}/package.json`));
}

/** The folder whose node_modules DSH should load from: a downloaded update when it is newer than the bundled copy. */
export async function updatedRoot(storage: string): Promise<string | undefined> {
  const updated = await versionAt(updatedPackageJson(storage));
  if (!updated) return undefined;
  const bundled = await bundledVersion();
  return !bundled || compareVersions(updated, bundled) > 0 ? updateRoot(storage) : undefined;
}

export async function currentVersion(storage: string): Promise<string | undefined> {
  const root = await updatedRoot(storage);
  return root ? versionAt(updatedPackageJson(storage)) : bundledVersion();
}

export async function latestVersion(): Promise<string | undefined> {
  const response = await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
  if (!response.ok) return undefined;
  const version = (await response.json() as { version?: unknown }).version;
  return typeof version === 'string' && isVersion(version) ? version : undefined;
}

/** Installs a DSH release into extension storage with npm. */
export function installVersion(storage: string, version: string): Promise<void> {
  if (!isVersion(version)) return Promise.reject(new Error('Unexpected DSH version.'));
  return (async () => {
    const root = updateRoot(storage);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dsh-runtime', private: true }), 'utf8');
    await new Promise<void>((resolve, reject) => {
      const child = spawn('npm', ['install', `${PACKAGE}@${version}`, '--no-audit', '--no-fund', '--loglevel=error'], { cwd: root, windowsHide: true, shell: process.platform === 'win32' });
      let output = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('npm took too long.')); }, 10 * 60_000);
      child.stderr.on('data', (chunk: Buffer) => { output = (output + chunk).slice(-1500); });
      child.on('error', error => { clearTimeout(timer); reject(error.message.includes('ENOENT') ? new Error('npm was not found on PATH.') : error); });
      child.on('exit', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(output.trim() || `npm exited with code ${code}.`)); });
    });
    if ((await versionAt(updatedPackageJson(storage))) !== version) throw new Error('The downloaded DSH could not be verified.');
  })();
}

export const dshBinFrom = (root: string | undefined): string =>
  require.resolve(`${PACKAGE}/lib/bin.js`, root ? { paths: [root] } : undefined);
