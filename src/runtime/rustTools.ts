import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { download, run } from './dependencies';

export const RUST_TOOLS = ['rg', 'fd', 'sd'] as const;
type RustTool = typeof RUST_TOOLS[number];
interface ReleaseAsset { name?: unknown; browser_download_url?: unknown; digest?: unknown; size?: unknown }
const repositories: Record<RustTool, string> = { rg: 'BurntSushi/ripgrep', fd: 'sharkdp/fd', sd: 'chmln/sd' };
let activeBin: string | undefined;
const pending = new Map<string, Promise<string | undefined>>();

/** The folder containing the managed executables. */
export function rustToolsBin(storage: string): string {
  return join(storage, 'dependencies', 'rust-tools', 'bin');
}

/** Select the Windows archive and its published checksum. */
export function pickRustToolAsset(tool: RustTool, assets: ReleaseAsset[], arch = process.arch): { url: string; sha256: string; name: string } {
  const prefix = tool === 'rg' ? 'ripgrep' : tool;
  const select = (architecture: string) => assets.find(item => typeof item.name === 'string' && new RegExp(`^${prefix}-v?\\d+\\.\\d+\\.\\d+[^/]*-${architecture}-pc-windows-msvc\\.zip$`).test(item.name));
  const asset = (arch === 'arm64' ? select('aarch64') : undefined) || select('x86_64');
  if (!asset) throw new Error(`No Windows archive found for ${tool}.`);
  const url = String(asset.browser_download_url || '');
  if (!url.startsWith(`https://github.com/${repositories[tool]}/releases/download/`)) throw new Error('Unexpected download address.');
  const sha256 = typeof asset.digest === 'string' ? asset.digest.match(/^sha256:([0-9a-f]{64})$/i)?.[1] : undefined;
  if (!sha256) throw new Error(`The ${tool} release does not publish a SHA-256 checksum.`);
  return { url, sha256: sha256.toLowerCase(), name: String(asset.name) };
}

async function probe(path: string): Promise<boolean> {
  try { return existsSync(path) && (await run(path, ['--version'])).code === 0; } catch { return false; }
}

async function findExecutable(directory: string, name: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name) return path;
    if (entry.isDirectory()) {
      const found = await findExecutable(path, name);
      if (found) return found;
    }
  }
  return undefined;
}

async function installTools(storage: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined;
  const bin = rustToolsBin(storage);
  await mkdir(bin, { recursive: true });
  for (const tool of RUST_TOOLS) {
    const target = join(bin, `${tool}.exe`);
    if (await probe(target)) continue;
    const response = await fetchImpl(`https://api.github.com/repos/${repositories[tool]}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-ide' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Could not look up ${tool} release.`);
    const release = await response.json() as { assets?: ReleaseAsset[] };
    const asset = pickRustToolAsset(tool, release.assets || []);
    const stage = await mkdtemp(join(storage, 'rust-tools-stage-'));
    try {
      const zip = join(stage, asset.name);
      await download(asset.url, zip, 150 * 1024 * 1024);
      const actual = createHash('sha256').update(await readFile(zip)).digest('hex');
      if (actual !== asset.sha256) throw new Error(`SHA-256 verification failed for ${asset.name}.`);
      const extracted = join(stage, 'extracted');
      await mkdir(extracted);
      const expansion = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:DSH_RUST_ZIP -DestinationPath $env:DSH_RUST_DEST -Force"],
      180_000, { ...process.env, DSH_RUST_ZIP: zip, DSH_RUST_DEST: extracted });
      if (expansion.code !== 0) throw new Error(`Could not expand ${asset.name}.`);
      const executable = await findExecutable(extracted, `${tool}.exe`);
      if (!executable || !await probe(executable)) throw new Error(`${tool} does not run.`);
      await copyFile(executable, target);
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  for (const tool of RUST_TOOLS) if (!await probe(join(bin, `${tool}.exe`))) return undefined;
  return bin;
}

/** Install and verify the managed tools on Windows. */
export async function ensureRustTools(storage: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  let promise = pending.get(storage);
  if (!promise) {
    promise = installTools(storage, fetchImpl).catch(() => undefined).finally(() => pending.delete(storage));
    pending.set(storage, promise);
  }
  return promise;
}

/** Activate the tools and create the agent shell environment. */
export function activateRustTools(bin: string): void {
  const directory = dirname(bin);
  mkdirSync(directory, { recursive: true });
  const script = `[ -n "$DSH_USER_BASH_ENV" ] && [ -f "$DSH_USER_BASH_ENV" ] && . "$DSH_USER_BASH_ENV"\ncase $- in\n  *c*)\n    for name in grep egrep fgrep find sed; do\n      eval "$name() { printf '%s\\n' '$name is not available here. Use rg (search), fd (find files) or sd (replace).' >&2; return 127; }"\n    done\n    ;;\nesac\n`;
  writeFileSync(join(directory, 'bash-env.sh'), script, 'utf8');
  activeBin = bin;
}

/** Stop adding the tools to agents started from now on. */
export function deactivateRustTools(): void {
  activeBin = undefined;
}

/** Add the activated tools to an agent environment. */
export function withRustTools(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!activeBin) return env;
  const result = { ...env };
  const key = Object.keys(result).find(item => item.toLowerCase() === 'path') || 'Path';
  result[key] = `${activeBin}${result[key] ? `${delimiter}${result[key]}` : ''}`;
  if (result.BASH_ENV) result.DSH_USER_BASH_ENV = result.BASH_ENV;
  result.BASH_ENV = join(dirname(activeBin), 'bash-env.sh');
  return result;
}

/** Describe the available shell tools to agents. */
export function rustToolsInstructions(): string {
  return activeBin ? 'Shell tools: search file contents with rg (ripgrep), find files with fd, and find-and-replace with sd. They are on PATH in every shell. grep, find and sed are not available.' : '';
}
