import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { compareVersions, isVersion } from './version';

export interface ExtensionRelease { version: string; downloadUrl: string; digest?: string }

export function parseRelease(value: unknown, repository: string, current: string): ExtensionRelease | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const release = value as Record<string, unknown>;
  if (release.draft || release.prerelease || typeof release.tag_name !== 'string') return undefined;
  const version = release.tag_name.replace(/^v/, '');
  if (!isVersion(version) || !isVersion(current) || compareVersions(version, current) <= 0) return undefined;
  if (!Array.isArray(release.assets)) return undefined;
  const assets = release.assets.filter((asset): asset is Record<string, unknown> => !!asset && typeof asset === 'object');
  // A single, universal VSIX avoids choosing an unrelated extension or the wrong platform.
  const matches = assets.filter(asset => asset.name === `dsh-ide-${version}.vsix`);
  if (matches.length !== 1) return undefined;
  const asset = matches[0];
  if (typeof asset.browser_download_url !== 'string') return undefined;
  let url: URL;
  try { url = new URL(asset.browser_download_url); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port
    || !url.pathname.startsWith(`/${repository}/releases/download/`)) return undefined;
  return { version, downloadUrl: url.href, digest: typeof asset.digest === 'string' ? asset.digest : undefined };
}

export async function latestExtensionRelease(repository: string, current: string): Promise<ExtensionRelease | undefined> {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Use owner/repository for the GitHub update repository.');
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'User-Agent': 'dsh-ide' }, signal: AbortSignal.timeout(8000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub update check returned HTTP ${response.status}.`);
  return parseRelease(await response.json(), repository, current);
}

/** The temporary VSIX exists until the host finishes installing it. */
export async function installExtensionRelease(release: ExtensionRelease, install: (path: string) => PromiseLike<unknown>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ide-update-'));
  try {
    const response = await fetch(release.downloadUrl, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw new Error(`VSIX download returned HTTP ${response.status}.`);
    const path = join(directory, 'update.vsix');
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(path));
    if (release.digest?.startsWith('sha256:')) {
      const hash = createHash('sha256').update(await readFile(path)).digest('hex');
      if (`sha256:${hash}` !== release.digest) throw new Error('The VSIX checksum did not match the GitHub release.');
    }
    await install(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
