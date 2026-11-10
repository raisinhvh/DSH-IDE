import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from '../runtime/dependencies';

/** Paths to a ready whisper.cpp install. */
export interface WhisperEngine {
  cli: string;
  model: string;
}

interface PinnedFile {
  url: string;
  sha256: string;
  size: number;
}

// Pinned so a new upstream build can't change what runs on the user's machine.
const BUILD_TAG = 'b5454';
const BUILD: PinnedFile = {
  url: `https://github.com/ggml-org/whisper.cpp/releases/download/${BUILD_TAG}/whisper-bin-x64.zip`,
  sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
  size: 8_928_640,
};
const MODEL_NAME = 'ggml-base.en.bin';
const MODEL: PinnedFile = {
  url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`,
  sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
  size: 147_964_211,
};
/** Total bytes a first install downloads, for the progress message. */
export const WHISPER_DOWNLOAD_BYTES = BUILD.size + MODEL.size;
const STALL_TIMEOUT = 60_000;

function paths(root: string): WhisperEngine & { build: string } {
  const build = join(root, BUILD_TAG);
  return {
    build,
    cli: join(build, 'Release', 'whisper-cli.exe'),
    model: join(root, MODEL_NAME),
  };
}

/** The installed engine under `root`, or undefined when it still needs downloading. */
export function installedWhisper(root: string): WhisperEngine | undefined {
  const { cli, model } = paths(root);
  return existsSync(cli) && existsSync(model) ? { cli, model } : undefined;
}

/** Downloads one pinned file, checking its hash; `onBytes` gets each chunk's length. */
async function fetchPinned(file: PinnedFile, destination: string, onBytes: (count: number) => void): Promise<void> {
  const controller = new AbortController();
  let stall = setTimeout(() => controller.abort(), STALL_TIMEOUT);
  const partial = `${destination}.part`;
  try {
    const response = await fetch(file.url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${file.url}`);
    const hash = createHash('sha256');
    const output = createWriteStream(partial);
    let total = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        clearTimeout(stall);
        stall = setTimeout(() => controller.abort(), STALL_TIMEOUT);
        total += chunk.length;
        if (total > file.size) throw new Error(`Download is larger than expected: ${file.url}`);
        hash.update(chunk);
        if (!output.write(chunk)) await new Promise<void>(resolve => output.once('drain', () => resolve()));
        onBytes(chunk.length);
      }
    } finally {
      await new Promise<void>(resolve => output.end(() => resolve()));
    }
    if (hash.digest('hex') !== file.sha256) throw new Error(`Downloaded file failed its SHA-256 check: ${file.url}`);
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    if (controller.signal.aborted) throw new Error(`Download stalled: ${file.url}`);
    throw error;
  } finally {
    clearTimeout(stall);
  }
}

/** Downloads whatever is missing of whisper.cpp and its English model; `onProgress` gets 0..1. */
export async function installWhisper(root: string, onProgress: (fraction: number) => void): Promise<WhisperEngine> {
  const target = paths(root);
  await mkdir(root, { recursive: true });
  let done = 0;
  const needed = (existsSync(target.cli) ? 0 : BUILD.size) + (existsSync(target.model) ? 0 : MODEL.size);
  const progress = (count: number) => {
    done += count;
    onProgress(needed ? Math.min(1, done / needed) : 1);
  };
  if (!existsSync(target.cli)) {
    const zip = join(root, 'whisper-bin-x64.zip');
    const staging = `${target.build}.staging`;
    try {
      await fetchPinned(BUILD, zip, progress);
      await rm(staging, { recursive: true, force: true });
      const expand = await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:DSH_WHISPER_ZIP -DestinationPath $env:DSH_WHISPER_DEST -Force"],
        120_000,
        { ...process.env, DSH_WHISPER_ZIP: zip, DSH_WHISPER_DEST: staging },
      );
      if (expand.code !== 0) throw new Error(`Could not unpack whisper.cpp: ${expand.stderr.slice(-1000)}`);
      if (!existsSync(join(staging, 'Release', 'whisper-cli.exe'))) throw new Error('The whisper.cpp download did not contain whisper-cli.exe.');
      await rm(target.build, { recursive: true, force: true });
      await rename(staging, target.build);
    } finally {
      await rm(zip, { force: true }).catch(() => undefined);
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  if (!existsSync(target.model)) await fetchPinned(MODEL, target.model, progress);
  return { cli: target.cli, model: target.model };
}
