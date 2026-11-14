import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, isAbsolute } from 'node:path';
import { terminateProcessTree } from './cancellation';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const DOWNLOAD_LIMIT = 250 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = 120_000;
const PROCESS_TIMEOUT = 180_000;
const PROVIDERS = new Set(['claude-cli', 'cursor-acp']);
const WINDOWS = process.platform === 'win32';
/** Folders a GUI-launched VS Code on macOS often lacks on PATH, where Homebrew, nvm-free installs and CLI installers put binaries. */
function unixBinDirs(): string[] {
  const home = homedir();
  return [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', join(home, '.volta', 'bin'), join(home, '.npm-global', 'bin')];
}
/** npm-cli.js next to a Node executable: <dir>/node_modules/npm on Windows, <prefix>/lib/node_modules/npm on macOS and Linux. */
function npmCli(nodeExecPath: string): string {
  const dir = dirname(nodeExecPath);
  return WINDOWS ? join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js') : join(dirname(dir), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

export function run(executable: string, args: string[], timeout = 15_000, env = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end();
    let stdout = '', stderr = '', done = false;
    const timer = setTimeout(() => { terminateProcessTree(child); finish(new Error(`${executable} timed out.`)); }, timeout);
    const finish = (error?: Error, code = -1) => {
      if (done) return;
      done = true; clearTimeout(timer);
      error ? reject(error) : resolve({ code, stdout, stderr });
    };
    child.stdout?.on('data', chunk => { if (stdout.length < 64_000) stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { if (stderr.length < 64_000) stderr += chunk.toString(); });
    child.once('error', error => finish(error));
    child.once('close', code => finish(undefined, code ?? -1));
  });
}

function version(text: string): number[] | undefined {
  const match = text.match(/v?(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : undefined;
}
function supported(text: string): boolean {
  const v = version(text);
  return !!v && (v[0] >= 24 || v[0] === 22 && (v[1] > 19 || v[1] === 19 && v[2] >= 0));
}
function pathKey(env: NodeJS.ProcessEnv): string | undefined { return Object.keys(env).find(key => key.toLowerCase() === 'path'); }
function prependPath(directory: string): void {
  const key = pathKey(process.env) || 'Path';
  const current = process.env[key] || '';
  const norm = (part: string) => { const trimmed = part.replace(/[\\/]+$/, ''); return WINDOWS ? trimmed.toLowerCase() : trimmed; };
  if (current.split(delimiter).some(part => norm(part) === norm(directory))) return;
  process.env[key] = `${directory}${current ? `${delimiter}${current}` : ''}`;
}
export async function download(url: string, destination: string, maxBytes = DOWNLOAD_LIMIT): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
    const size = Number(response.headers.get('content-length') || 0);
    if (size > maxBytes) throw new Error(`Download exceeds ${maxBytes} bytes.`);
    let count = 0;
    const limited = Readable.from((async function* () {
      for await (const chunk of response.body!) { count += chunk.length; if (count > maxBytes) throw new Error('Download size limit exceeded.'); yield chunk; }
    })());
    await pipeline(limited, createWriteStream(destination));
  } finally { clearTimeout(timer); }
}
function safeName(provider: string): string {
  if (!PROVIDERS.has(provider)) throw new Error(`Unsupported provider '${provider}'.`);
  return provider;
}

export class WindowsDependencies {
  private nodePromise?: Promise<string>;
  private providerPromises = new Map<string, Promise<void>>();
  // Despite the name this also runs on macOS and Linux: there it finds tools already installed and uses the official
  // shell installers. Throwing here on other platforms stopped the extension activating, so the sidebar never loaded.
  constructor(private readonly storage: string, private readonly configuredNode?: () => string | undefined,
    private readonly configuredProvider?: (provider: string) => string | undefined) {}

  ensureNode(): Promise<string> {
    if (!this.nodePromise) this.nodePromise = this.ensureNodeOnce().catch(error => { this.nodePromise = undefined; throw error; });
    return this.nodePromise;
  }

  private async probeNode(executable: string): Promise<boolean> {
    try {
      const node = await run(executable, ['--version']);
      if (node.code !== 0 || !supported(node.stdout + node.stderr)) return false;
      const location = await run(executable, ['-p', 'process.execPath']);
      if (location.code !== 0) return false;
      const npmPath = npmCli(location.stdout.trim());
      if (!existsSync(npmPath)) return false;
      const npmRun = await run(executable, [npmPath, '--version']);
      return npmRun.code === 0 && !!version(npmRun.stdout);
    } catch { return false; }
  }

  private async ensureNodeOnce(): Promise<string> {
    const configured = this.configuredNode?.()?.trim();
    if (configured) {
      if (!await this.probeNode(configured)) throw new Error(`Configured Node executable '${configured}' is invalid or unsupported. Install Node 22.19+ (22.x) or 24+, with working npm, or update dsh.runtime.nodePath.`);
      const location = await run(configured, ['-p', 'process.execPath']);
      const executable = location.stdout.trim();
      prependPath(dirname(executable)); return executable;
    }
    const candidates = WINDOWS ? [join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'), 'node.exe']
      : ['node', ...unixBinDirs().map(dir => join(dir, 'node'))];
    for (const candidate of candidates) if (await this.probeNode(candidate)) {
      const resolved = await run(candidate, ['-p', 'process.execPath']);
      const executable = resolved.stdout.trim() || candidate;
      prependPath(dirname(executable)); return executable;
    }
    if (!WINDOWS) throw new Error('Node.js 22.19+ or 24+ with npm was not found. Install it (for example `brew install node` or from nodejs.org), or set dsh.runtime.nodePath, then try again.');
    const root = join(this.storage, 'dependencies', 'node');
    const managed = join(root, 'node.exe');
    if (await this.probeNode(managed)) { prependPath(root); return managed; }
    await mkdir(root, { recursive: true });
    const stage = await mkdtemp(join(this.storage, 'node-stage-'));
    try {
      const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
      const indexResponse = await fetch('https://nodejs.org/dist/index.json', { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) });
      if (!indexResponse.ok) throw new Error(`Could not retrieve Node releases (${indexResponse.status}).`);
      const releases = await indexResponse.json() as Array<{ version: string; lts: string | boolean }>;
      const release = releases.find(item => /^v24\.\d+\.\d+$/.test(item.version) && item.lts);
      if (!release) throw new Error('No Node 24 LTS Windows release was found.');
      const base = `https://nodejs.org/dist/${release.version}`;
      const archive = `node-${release.version}-win-${arch}.zip`;
      const zip = join(stage, archive), sums = join(stage, 'SHASUMS256.txt');
      const downloads = await Promise.allSettled([download(`${base}/${archive}`, zip), download(`${base}/SHASUMS256.txt`, sums, 2_000_000)]);
      for (const result of downloads) if (result.status === 'rejected') throw result.reason;
      const sumText = await readFile(sums, 'utf8');
      const expected = sumText.split(/\r?\n/).find(line => line.trim().endsWith(` ${archive}`))?.trim().split(/\s+/)[0];
      if (!expected || createHash('sha256').update(await readFile(zip)).digest('hex').toLowerCase() !== expected.toLowerCase()) throw new Error(`SHA-256 verification failed for ${archive}.`);
      const extracted = join(stage, 'extracted'); await mkdir(extracted);
      const expansion = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:DSH_NODE_ZIP -DestinationPath $env:DSH_NODE_DEST -Force"], PROCESS_TIMEOUT, { ...process.env, DSH_NODE_ZIP: zip, DSH_NODE_DEST: extracted });
      if (expansion.code !== 0) throw new Error(`Could not expand the downloaded Node archive: ${expansion.stderr.slice(-2000)}`);
      const entries = await readdir(extracted);
      const unpacked = entries.map(entry => join(extracted, entry)).find(path => existsSync(join(path, 'node.exe')));
      if (!unpacked) throw new Error('Downloaded Node archive did not contain node.exe.');
      if (!await this.probeNode(join(unpacked, 'node.exe'))) throw new Error('Downloaded Node or npm failed its version check.');
      await rm(root, { recursive: true, force: true });
      await rename(unpacked, root);
      if (!await this.probeNode(managed)) throw new Error('Installed Node or npm failed its version check.');
      prependPath(root); return managed;
    } finally { await rm(stage, { recursive: true, force: true }).catch(() => undefined); }
  }

  async providerCommand(provider: string): Promise<string | undefined> {
    safeName(provider);
    const configured = this.configuredProvider?.(provider)?.trim();
    if (configured && !(provider === 'cursor-acp' && configured === 'agent')) {
      if (provider === 'cursor-acp') {
        const root = /\.(cmd|ps1)$/i.test(configured) ? dirname(configured) : configured;
        const node = this.cursorNode(root);
        if (node) return node;
      }
      return await this.isExecutable(configured) ? configured : undefined;
    }
    const candidates = this.providerCandidates(provider);
    for (const candidate of candidates) if (await this.isExecutable(candidate)) return candidate;
    return undefined;
  }

  private providerCandidates(provider: string): string[] {
    if (!WINDOWS) return this.unixProviderCandidates(provider);
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    if (provider === 'claude-cli') return [join(homedir(), '.local', 'bin', 'claude.exe'), join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), 'claude.exe'];
    const root = join(local, 'cursor-agent');
    const node = this.cursorNode(root);
    return [...(node ? [node] : []), 'agent.exe', join(root, 'agent.exe')];
  }

  private unixProviderCandidates(provider: string): string[] {
    const home = homedir();
    const inDirs = (name: string) => unixBinDirs().map(dir => join(dir, name));
    if (provider === 'claude-cli') return [join(home, '.claude', 'local', 'claude'), ...inDirs('claude'), 'claude'];
    return [...inDirs('cursor-agent'), ...inDirs('agent'), 'cursor-agent'];
  }

  private cursorNode(root: string): string | undefined {
    const versions = join(root, 'versions');
    try {
      for (const entry of readdirSync(versions).sort().reverse()) {
        const directory = join(versions, entry);
        const node = WINDOWS ? 'node.exe' : 'node';
        if (existsSync(join(directory, node)) && existsSync(join(directory, 'index.js'))) return join(directory, node);
      }
    } catch { /* installation may be absent */ }
    return undefined;
  }

  private async isExecutable(path: string): Promise<boolean> {
    if (isAbsolute(path) && !existsSync(path)) return false;
    const ext = path.toLowerCase();
    try {
      if (!WINDOWS || ext.endsWith('.exe') || !/[\\/]/.test(path)) {
        const cursorScript = join(dirname(path), 'index.js');
        return (await run(path, existsSync(cursorScript) && /[\\/]node(\.exe)?$/i.test(path) ? [cursorScript, '--version'] : ['--version'])).code === 0;
      }
      return false;
    } catch { return false; }
  }

  async installProvider(provider: string): Promise<void> {
    safeName(provider);
    const existing = await this.providerCommand(provider);
    if (existing) return;
    const pending = this.providerPromises.get(provider);
    if (pending) return pending;
    const promise = this.installProviderOnce(provider).finally(() => this.providerPromises.delete(provider));
    this.providerPromises.set(provider, promise); return promise;
  }

  private async installProviderOnce(provider: string): Promise<void> {
    const configured = this.configuredProvider?.(provider)?.trim();
    if (configured && !(provider === 'cursor-acp' && configured === 'agent')) throw new Error(`Configured ${provider} executable '${configured}' was not found or could not run. Clear its custom path in Settings before installing.`);
    const stage = await mkdtemp(join(tmpdir(), `dsh-${provider}-`));
    if (!WINDOWS) {
      try {
        const script = join(stage, 'install.sh');
        await download(provider === 'claude-cli' ? 'https://claude.ai/install.sh' : 'https://cursor.com/install', script, 4_000_000);
        const result = await run('/bin/bash', [script], PROCESS_TIMEOUT);
        if (result.code !== 0) throw new Error(`${provider} installer failed: ${(result.stderr || result.stdout).slice(-2000)}`);
        if (!await this.providerCommand(provider)) throw new Error(`${provider} installer completed, but its executable was not found.`);
      } finally { await rm(stage, { recursive: true, force: true }).catch(() => undefined); }
      return;
    }
    const script = join(stage, 'install.ps1');
    try {
      const url = provider === 'claude-cli' ? 'https://claude.ai/install.ps1' : 'https://cursor.com/install?win32=true';
      await download(url, script, 4_000_000);
      const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], PROCESS_TIMEOUT);
      if (result.code !== 0) throw new Error(`${provider} installer failed: ${result.stderr.slice(-2000)}`);
      if (!await this.providerCommand(provider)) throw new Error(`${provider} installer completed, but its native Windows executable was not found.`);
    } finally { await rm(stage, { recursive: true, force: true }).catch(() => undefined); }
  }
}
