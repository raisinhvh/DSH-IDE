import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, isAbsolute } from 'node:path';
import { terminateProcessTree } from './cancellation';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const DOWNLOAD_LIMIT = 250 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = 120_000;
const PROCESS_TIMEOUT = 180_000;
const PROVIDERS = new Set(['codex-cli', 'claude-cli', 'cursor-acp']);

function run(executable: string, args: string[], timeout = 15_000, env = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
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
  if (current.split(';').some(part => part.replace(/[\\/]+$/, '').toLowerCase() === directory.replace(/[\\/]+$/, '').toLowerCase())) return;
  process.env[key] = `${directory}${current ? `;${current}` : ''}`;
}
async function download(url: string, destination: string, maxBytes = DOWNLOAD_LIMIT): Promise<void> {
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
  constructor(private readonly storage: string, private readonly configuredNode?: () => string | undefined,
    private readonly configuredProvider?: (provider: string) => string | undefined) {
    if (process.platform !== 'win32') throw new Error('WindowsDependencies is available only on Windows.');
  }

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
      const npmPath = join(dirname(location.stdout.trim()), 'node_modules', 'npm', 'bin', 'npm-cli.js');
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
    const candidates = [join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'), 'node.exe'];
    for (const candidate of candidates) if (await this.probeNode(candidate)) {
      const resolved = await run(candidate, ['-p', 'process.execPath']);
      const executable = resolved.stdout.trim() || candidate;
      prependPath(dirname(executable)); return executable;
    }
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
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    if (provider === 'codex-cli') {
      const roots = [join(this.storage, 'dependencies', 'providers', 'codex', 'node_modules', '@openai', 'codex'), join(appData, 'npm', 'node_modules', '@openai', 'codex')];
      const found: string[] = [];
      for (const root of roots) {
        for (const relative of ['vendor/x86_64-pc-windows-msvc/codex/codex.exe', 'vendor/aarch64-pc-windows-msvc/codex/codex.exe', 'bin/codex.exe', 'codex.exe']) found.push(join(root, relative));
        try {
          const walk = (directory: string, depth: number) => {
            if (depth > 5) return;
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
              const child = join(directory, entry.name);
              if (entry.isFile() && entry.name.toLowerCase() === 'codex.exe') found.push(child);
              else if (entry.isDirectory()) walk(child, depth + 1);
            }
          };
          if (existsSync(root)) walk(root, 0);
          const scope = dirname(root);
          if (existsSync(scope)) for (const entry of readdirSync(scope, { withFileTypes: true })) {
            if (entry.isDirectory() && /^codex-win32-/.test(entry.name)) walk(join(scope, entry.name), 0);
          }
        } catch { /* package may not be installed */ }
      }
      return [...found, join(local, 'Programs', 'codex', 'codex.exe'), 'codex.exe'];
    }
    if (provider === 'claude-cli') return [join(homedir(), '.local', 'bin', 'claude.exe'), join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), 'claude.exe'];
    const root = join(local, 'cursor-agent');
    const node = this.cursorNode(root);
    return [...(node ? [node] : []), 'agent.exe', join(root, 'agent.exe')];
  }

  private cursorNode(root: string): string | undefined {
    const versions = join(root, 'versions');
    try {
      for (const entry of readdirSync(versions).sort().reverse()) {
        const directory = join(versions, entry);
        if (existsSync(join(directory, 'node.exe')) && existsSync(join(directory, 'index.js'))) return join(directory, 'node.exe');
      }
    } catch { /* installation may be absent */ }
    return undefined;
  }

  private async isExecutable(path: string): Promise<boolean> {
    if (isAbsolute(path) && !existsSync(path)) return false;
    const ext = path.toLowerCase();
    try {
      if (ext.endsWith('.exe') || !/[\\/]/.test(path)) {
        const cursorScript = join(dirname(path), 'index.js');
        return (await run(path, existsSync(cursorScript) && /node\.exe$/i.test(path) ? [cursorScript, '--version'] : ['--version'])).code === 0;
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
    if (provider === 'codex-cli') {
      const node = await this.ensureNode();
      const npm = join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      const prefix = join(this.storage, 'dependencies', 'providers', 'codex');
      await mkdir(prefix, { recursive: true });
      const result = await run(node, [npm, 'install', '--prefix', prefix, '@openai/codex'], PROCESS_TIMEOUT);
      if (result.code !== 0) throw new Error(`Codex installation failed: ${result.stderr.slice(-2000)}`);
      if (!await this.providerCommand(provider)) throw new Error('Codex installed, but no native Windows codex.exe was found.');
      return;
    }
    const stage = await mkdtemp(join(tmpdir(), `dsh-${provider}-`));
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
