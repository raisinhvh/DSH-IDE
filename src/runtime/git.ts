import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { download, run } from './dependencies';

export const GIT_DOWNLOAD_PAGE = 'https://git-scm.com/downloads';
/** Git reads config from GIT_CONFIG_COUNT (how sync passes its token) from 2.31 on. */
const MIN_VERSION = [2, 31];
const RELEASE_API = 'https://api.github.com/repos/git-for-windows/git/releases/latest';
const DOWNLOAD_PREFIX = 'https://github.com/git-for-windows/git/releases/download/';

export function gitVersionOk(text: string): boolean {
  const match = text.match(/git version (\d+)\.(\d+)/);
  if (!match) return false;
  const [major, minor] = match.slice(1).map(Number);
  return major > MIN_VERSION[0] || (major === MIN_VERSION[0] && minor >= MIN_VERSION[1]);
}

async function probe(path: string): Promise<boolean> {
  try {
    const result = await run(path, ['--version']);
    return result.code === 0 && gitVersionOk(result.stdout);
  } catch { return false; }
}

const managedGit = (storage: string): string => join(storage, 'dependencies', 'git', 'cmd', 'git.exe');

/** The first working git: configured paths, then PATH, then the usual Windows locations, then the copy DSH installed. */
export async function findGit(storage: string, configured: (string | undefined)[] = []): Promise<string | undefined> {
  const windows = process.platform === 'win32';
  const candidates = [
    ...configured.map(item => item?.trim()).filter((item): item is string => !!item),
    windows ? 'git.exe' : 'git',
    ...(windows ? [
      join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
      join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Local'), 'Programs', 'Git', 'cmd', 'git.exe'),
      managedGit(storage),
    ] : []),
  ];
  for (const candidate of candidates) if (await probe(candidate)) return candidate;
  return undefined;
}

interface ReleaseAsset { name?: unknown; browser_download_url?: unknown; digest?: unknown; size?: unknown }

/** The MinGit archive for this PC from a Git for Windows release, with its published SHA-256. */
export function pickMinGit(assets: ReleaseAsset[], arch = process.arch): { url: string; sha256: string; name: string } {
  const suffix = arch === 'arm64' ? 'arm64' : '64-bit';
  const asset = assets.find(item => typeof item.name === 'string' && new RegExp(`^MinGit-\\d+(?:\\.\\d+){2,3}(?:\\.windows\\.\\d+)?-${suffix}\\.zip$`).test(item.name));
  if (!asset) throw new Error(`The latest Git for Windows release has no MinGit download for ${suffix}.`);
  const url = String(asset.browser_download_url || '');
  if (!url.startsWith(DOWNLOAD_PREFIX)) throw new Error('Unexpected Git download address.');
  const sha256 = typeof asset.digest === 'string' ? asset.digest.match(/^sha256:([0-9a-f]{64})$/i)?.[1] : undefined;
  if (!sha256) throw new Error('The Git release does not publish a SHA-256 checksum, so DSH will not install it.');
  return { url, sha256: sha256.toLowerCase(), name: String(asset.name) };
}

/**
 * Installs MinGit (Git for Windows' minimal, portable build) into DSH's storage, after checking the SHA-256 that
 * GitHub publishes for the release file. Nothing outside DSH's storage changes. Windows only.
 */
export async function installGit(storage: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (process.platform !== 'win32') throw new Error(`Install Git from ${GIT_DOWNLOAD_PAGE}, then try again.`);
  const response = await fetchImpl(RELEASE_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-ide' }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Could not look up the latest Git release (HTTP ${response.status}).`);
  const release = await response.json() as { assets?: ReleaseAsset[] };
  const asset = pickMinGit(release.assets || []);
  await mkdir(join(storage, 'dependencies'), { recursive: true });
  const stage = await mkdtemp(join(storage, 'git-stage-'));
  try {
    const zip = join(stage, asset.name);
    await download(asset.url, zip, 150 * 1024 * 1024);
    const actual = createHash('sha256').update(await readFile(zip)).digest('hex');
    if (actual !== asset.sha256) throw new Error(`SHA-256 verification failed for ${asset.name}.`);
    const extracted = join(stage, 'git');
    await mkdir(extracted);
    const expansion = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:DSH_GIT_ZIP -DestinationPath $env:DSH_GIT_DEST -Force"],
    180_000, { ...process.env, DSH_GIT_ZIP: zip, DSH_GIT_DEST: extracted });
    if (expansion.code !== 0) throw new Error(`Could not expand the Git archive: ${expansion.stderr.slice(-1000)}`);
    if (!existsSync(join(extracted, 'cmd', 'git.exe'))) throw new Error('The Git archive does not contain cmd\\git.exe.');
    const target = join(storage, 'dependencies', 'git');
    await rm(target, { recursive: true, force: true });
    await rename(extracted, target);
    const git = managedGit(storage);
    if (!await probe(git)) throw new Error('Git was installed but does not run.');
    return git;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
