import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs, watch, FSWatcher } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join, relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import { assertLocalFileScheme } from '../review/guards';

export interface MirrorChange {
  path: string;
  base?: string;
  proposed?: string;
}

const excluded = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', '.next', '.turbo', '.npm-cache']);
const skippedFile = (name: string): boolean => name === '.env' || name.startsWith('.env.') || name.endsWith('.key') || name.endsWith('.pem') ||
  /\.tmp\.\d+\.[0-9a-f]+$/i.test(name);

/** True when a workspace-relative path is outside the DSH mirror scope. */
export function mirrorPathExcluded(relPath: string): boolean {
  const normalized = relPath.replaceAll('\\', '/');
  const segments = normalized.split('/').filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    const part = segments[index];
    if (part === '.dsh' && segments[index + 1] !== 'skills') return true;
    if (excluded.has(part) || skippedFile(part)) return true;
  }
  return false;
}
const decoder = new TextDecoder('utf-8', { fatal: true });
const text = (bytes: Buffer): string | undefined => {
  if (bytes.includes(0)) return undefined;
  try { return decoder.decode(bytes); } catch { return undefined; }
};

async function gitIgnored(root: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  return new Promise(resolveIgnored => {
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: Set<string>): void => { if (!finished) { finished = true; if (timer) clearTimeout(timer); resolveIgnored(result); } };
    let child;
    try { child = spawn('git', ['-C', root, 'check-ignore', '-z', '--stdin'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { finish(new Set()); return; }
    let output = '';
    timer = setTimeout(() => { child.kill(); finish(new Set()); }, 5000);
    child.on('error', () => finish(new Set()));
    child.stdin.on('error', () => finish(new Set()));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 4_000_000) { child.kill(); finish(new Set()); }
    });
    child.on('close', code => finish(code === 0 || code === 1 ? new Set(output.split('\0').filter(Boolean)) : new Set()));
    child.stdin.end(paths.join('\0') + '\0');
  });
}

/** A private copy in extension storage: DSH edits here; VS Code applies reviewed proposals to the real workspace. */
export class WorkspaceMirror implements vscode.Disposable {
  private watcher?: FSWatcher;
  private poll?: NodeJS.Timeout;
  private baseline: Record<string, string> = {};
  private lastKeys = new Set<string>();
  private opQueue: Promise<void> = Promise.resolve();
  private watchedScan?: Promise<void>;
  public readonly id: string;
  public readonly cwd: string;
  private readonly metadata: string;

  private constructor(
    private readonly root: vscode.Uri,
    storage: string,
    id: string,
    private readonly onChanges: (changes: MirrorChange[]) => void,
  ) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid DSH mirror ID.');
    this.id = id;
    const workspaceKey = createHash('sha256').update(root.fsPath).digest('hex').slice(0, 16);
    const home = join(storage, 'mirrors', workspaceKey, id);
    this.cwd = join(home, 'workspace');
    this.metadata = join(home, 'baseline.json.gz');
  }

  public static async create(root: vscode.Uri, storage: string, onChanges: (changes: MirrorChange[]) => void, id: string = randomUUID()): Promise<WorkspaceMirror> {
    assertLocalFileScheme(root.scheme);
    const mirror = new WorkspaceMirror(root, storage, id, onChanges);
    await fs.mkdir(mirror.cwd, { recursive: true });
    const config = vscode.workspace.getConfiguration('dsh');
    const maxFiles = config.get<number>('runtime.maxWorkspaceFiles', 4000);
    const maxBytes = config.get<number>('runtime.maxWorkspaceBytes', 104857600);
    const realRoot = await fs.realpath(root.fsPath);
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*'), '**/{.git,node_modules,.venv,venv,dist,build,.next,.turbo,.npm-cache}/**', maxFiles + 1);
    if (uris.length > maxFiles) throw new Error(`Workspace has more than ${maxFiles} files in the DSH review scope. Increase dsh.runtime.maxWorkspaceFiles or narrow the workspace.`);
    const ignored = await gitIgnored(root.fsPath, uris.map(uri => relative(root.fsPath, uri.fsPath).replaceAll('\\', '/')));
    let bytes = 0;
    for (const uri of uris) {
      assertLocalFileScheme(uri.scheme);
      const rel = mirror.safeRelative(uri.fsPath);
      if (!rel) continue;
      const normalized = rel.replaceAll('\\', '/');
      if (ignored.has(normalized) || mirrorPathExcluded(normalized)) continue;
      const stat = await fs.lstat(uri.fsPath);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const realFile = await fs.realpath(uri.fsPath);
      const realRel = relative(realRoot, realFile);
      if (realRel === '..' || realRel.startsWith('..' + sep)) continue;
      bytes += stat.size;
      if (bytes > maxBytes) throw new Error(`Workspace exceeds the ${maxBytes} byte DSH review scope. Increase dsh.runtime.maxWorkspaceBytes or narrow the workspace.`);
      const destination = join(mirror.cwd, rel);
      await fs.mkdir(resolve(destination, '..'), { recursive: true });
      const open = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString() && doc.isDirty);
      const contents = open ? Buffer.from(open.getText(), 'utf8') : await fs.readFile(uri.fsPath);
      await fs.writeFile(destination, contents);
      const decoded = contents.length <= 2_000_000 ? text(contents) : undefined;
      if (decoded !== undefined) mirror.baseline[rel] = decoded;
    }
    await fs.writeFile(mirror.metadata, gzipSync(Buffer.from(JSON.stringify(mirror.baseline), 'utf8')));
    mirror.startWatching();
    return mirror;
  }

  public static async reopen(root: vscode.Uri, storage: string, id: string, onChanges: (changes: MirrorChange[]) => void): Promise<WorkspaceMirror> {
    const mirror = new WorkspaceMirror(root, storage, id, onChanges);
    mirror.baseline = JSON.parse(gunzipSync(await fs.readFile(mirror.metadata)).toString('utf8')) as Record<string, string>;
    mirror.startWatching();
    await mirror.scan();
    return mirror;
  }

  /** Deletes a chat's private copy from extension storage. */
  public static async remove(root: vscode.Uri, storage: string, id: string): Promise<void> {
    const mirror = new WorkspaceMirror(root, storage, id, () => undefined);
    await fs.rm(resolve(mirror.cwd, '..'), { recursive: true, force: true });
  }

  public scan(): Promise<void> {
    return this.enqueue(() => this.runScan());
  }

  private scheduleScan(): Promise<void> {
    // A burst of filesystem events must not queue hundreds of full scans ahead
    // of the final scan that sendPrompt awaits before showing Ready.
    return this.watchedScan ??= this.scan().finally(() => { this.watchedScan = undefined; });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.opQueue.then(operation);
    this.opQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async runScan(): Promise<void> {
    const current = new Map<string, string>();
    const oversized = new Set<string>();
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '.dsh') {
            const skills = join(full, 'skills');
            try { if ((await fs.lstat(skills)).isDirectory()) await walk(skills); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            continue;
          }
          if (excluded.has(entry.name) || skippedFile(entry.name)) continue;
          await walk(full);
          continue;
        }
        if (excluded.has(entry.name) || skippedFile(entry.name)) continue;
        if (!entry.isFile()) continue;
        const rel = this.safeRelative(full, this.cwd);
        if (!rel || mirrorPathExcluded(rel.replaceAll('\\', '/'))) continue;
        const stat = await fs.stat(full);
        if (stat.size > 2_000_000) { oversized.add(rel); continue; }
        const decoded = text(await fs.readFile(full));
        if (decoded !== undefined) current.set(rel, decoded);
      }
    };
    await walk(this.cwd);
    const keys = new Set([...Object.keys(this.baseline), ...current.keys(), ...this.lastKeys]);
    const changes: MirrorChange[] = [];
    for (const path of keys) {
      if (oversized.has(path) || mirrorPathExcluded(path)) continue;
      const base = this.baseline[path];
      const proposed = current.get(path);
      if (base !== proposed || this.lastKeys.has(path)) changes.push({ path, base, proposed });
    }
    this.lastKeys = new Set(changes.filter(change => change.base !== change.proposed).map(change => change.path));
    this.onChanges(changes);
  }

  public uri(path: string): vscode.Uri {
    const rel = this.safeRelative(join(this.root.fsPath, path));
    if (!rel) throw new Error('Path is outside the workspace.');
    return vscode.Uri.file(join(this.root.fsPath, rel));
  }

  /** Advance the review baseline only after VS Code has applied an edit. */
  public acknowledge(path: string, contents?: string): Promise<void> {
    return this.enqueue(async () => {
      const rel = this.safeRelative(join(this.root.fsPath, path));
      if (!rel) throw new Error('Path is outside the workspace.');
      if (contents === undefined) delete this.baseline[rel];
      else this.baseline[rel] = contents;
      await this.persistBaseline();
      await this.runScan();
    });
  }

  /** Rewind mirror bytes and baseline after a rejected proposal. */
  public restore(path: string, contents?: string): Promise<void> {
    return this.enqueue(async () => {
      const rel = this.safeRelative(join(this.root.fsPath, path));
      if (!rel) throw new Error('Path is outside the workspace.');
      const mirrorPath = join(this.cwd, rel);
      if (contents === undefined) {
        delete this.baseline[rel];
        try { await fs.rm(mirrorPath, { force: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      } else {
        this.baseline[rel] = contents;
        await fs.mkdir(resolve(mirrorPath, '..'), { recursive: true });
        await fs.writeFile(mirrorPath, Buffer.from(contents, 'utf8'));
      }
      await this.persistBaseline();
      await this.runScan();
    });
  }

  private async persistBaseline(): Promise<void> {
    await fs.writeFile(this.metadata, gzipSync(Buffer.from(JSON.stringify(this.baseline), 'utf8')));
  }

  public dispose(): void {
    this.watcher?.close();
    if (this.poll) clearInterval(this.poll);
  }

  private safeRelative(path: string, root = this.root.fsPath): string | undefined {
    const rel = relative(root, path);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || resolve(root, rel) !== resolve(path)) return undefined;
    return rel;
  }

  private startWatching(): void {
    try { this.watcher = watch(this.cwd, { recursive: true }, () => { void this.scheduleScan(); }); }
    catch { /* Polling handles platforms without recursive watch. */ }
    this.poll = setInterval(() => { void this.scheduleScan(); }, 2000);
  }
}
