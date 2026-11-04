import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs, statSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { SidebarSync } from '../sidebar/view';
import {
  AccountRef, ConfigBundle, SYNCED_SETTINGS, SyncRoots, applyFiles, applyToolpackSettings, bundleToTree, collectFiles, collectToolpacks, createSyncRepo,
  describeChanges, findConfigGist, findSyncRepo, hashBundle, localModels, mergeBundles, parseBundle, portableModels, readConfigGist, restoreMcpSecrets,
  serializeBundle, stableJson, stripMcpSecrets, treeToBundle,
} from './configSync';
import { GitAuth, PushRejected, SyncClone } from './gitRepo';

const STATE_KEY = 'dsh.ide.configSync.v2';
/** The gist-based sync this replaced; only its auto setting is carried over. */
const LEGACY_STATE_KEY = 'dsh.ide.configSync.v1';
/** Local edits are batched so a burst of saves makes one commit. */
const UPLOAD_DELAY = 5000;
/** Regaining focus looks for edits from other PCs at most this often. */
const FOCUS_CHECK_INTERVAL = 60_000;
/** While auto sync is on, GitHub is also checked this often, so a window that stays focused still picks up edits. */
const POLL_INTERVAL = 2 * 60_000;
/** The GitHub copy as of the last sync, kept so edits made on both PCs can be merged. */
const BASE_FILE = 'config-sync-base.json';
const CLONE_DIR = 'sync-repo';
const EMPTY: ConfigBundle = { format: 'dsh-config', version: 1, settings: {}, files: {}, toolpacks: {} };

interface SyncState {
  /** owner/dsh-sync */
  repo?: string;
  repoUrl?: string;
  cloneUrl?: string;
  account?: string;
  auto: boolean;
  /** Hash of the GitHub copy as of the last upload or download. */
  remoteHash?: string;
  /** Hash of this PC's config right after the last upload or download. */
  localHash?: string;
  lastSync?: number;
  /** The global memory folder the last sync used, so pointing memory at another folder merges instead of deleting. */
  memoryRoot?: string;
}

export interface SyncToolpacks {
  list(): { id: string; enabled: boolean }[];
  add(sourcePath: string): Promise<unknown>;
  remove(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
}

export interface ConfigSyncHost {
  roots(): SyncRoots;
  accounts(): AccountRef[];
  toolpacks: SyncToolpacks;
  /** A working git executable, if one is installed. */
  git(): Promise<string | undefined>;
  /** Sets this PC's global memory folder to a default one, for config from GitHub that has memory, and returns it. */
  adoptMemoryRoot(): Promise<string>;
  log(line: string): void;
  post(state: SidebarSync): void;
  /** Called after a download so views that do not watch settings can refresh. */
  applied(): Promise<void>;
}

const hasMemory = (bundle: ConfigBundle): boolean => Object.keys(bundle.files).some(path => path.startsWith('memory/'));
const withoutMemory = (bundle: ConfigBundle): ConfigBundle => ({ ...bundle, files: Object.fromEntries(Object.entries(bundle.files).filter(([path]) => !path.startsWith('memory/'))) });

/**
 * Keeps global rules, skills, toolpacks, `dsh.*` user settings and global memory in a private GitHub repository
 * (`dsh-sync`), one commit per sync. DSH works in its own clone; the merge happens item by item against the
 * GitHub copy as of the last sync, exactly as before.
 */
export class ConfigSync implements vscode.Disposable {
  private queue: Promise<unknown> = Promise.resolve();
  private busy?: SidebarSync['busy'];
  private error?: string;
  private timer?: NodeJS.Timeout;
  private poll?: NodeJS.Timeout;
  /** Items both PCs changed differently, waiting for a choice on the Sync page. Empty means the whole config (no base to merge from). */
  private conflict?: string[];
  private notified = '';
  private applying = false;
  private ready = false;
  private lastCheck = 0;

  public constructor(private readonly context: vscode.ExtensionContext, private readonly host: ConfigSyncHost) {}

  public dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearInterval(this.poll);
  }

  private get saved(): SyncState {
    const legacy = this.context.globalState.get<{ auto?: boolean }>(LEGACY_STATE_KEY, {});
    return { auto: legacy.auto !== false, ...this.context.globalState.get<Partial<SyncState>>(STATE_KEY, {}) };
  }
  private async save(patch: Partial<SyncState>): Promise<void> { await this.context.globalState.update(STATE_KEY, { ...this.saved, ...patch }); }

  public get connected(): boolean { return !!this.saved.repo; }
  public get repoUrl(): string | undefined { return this.saved.repoUrl; }

  public post(): void {
    const state = this.saved;
    this.host.post({ connected: !!state.repo, account: state.account, repoUrl: state.repoUrl, repo: state.repo, auto: state.auto, lastSync: state.lastSync, busy: this.busy, error: this.error, conflict: this.conflict });
  }

  /** Runs sync work one at a time and reports its progress and errors on the Sync page. */
  private run<T>(busy: SidebarSync['busy'], task: () => Promise<T>, quiet = false): Promise<T | undefined> {
    const next = this.queue.then(async () => {
      this.busy = busy;
      if (!quiet) this.error = undefined;
      this.post();
      try { return await task(); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.host.log(`Config sync: ${message}`);
        this.error = message;
        return undefined;
      } finally { this.busy = undefined; this.post(); }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Read and write access to the user's private repositories, and gists to bring over a config from the earlier gist sync. */
  private async session(interactive: boolean): Promise<GitAuth & { session: vscode.AuthenticationSession }> {
    const session = await vscode.authentication.getSession('github', ['repo', 'gist'], interactive ? { createIfNone: true } : { silent: true });
    if (!session) throw new Error('Sign in to GitHub on the Sync page to keep syncing.');
    if (session.account.label !== this.saved.account) await this.save({ account: session.account.label });
    return { token: session.accessToken, login: session.account.label, session };
  }

  private async clone(): Promise<SyncClone> {
    const git = await this.host.git();
    if (!git) throw new Error('Git is not installed. Choose Connect on the Sync page to install it.');
    const url = this.saved.cloneUrl;
    if (!url) throw new Error('Sync is not connected.');
    const clone = new SyncClone(join(this.context.globalStorageUri.fsPath, CLONE_DIR), git);
    await clone.prepare(url);
    return clone;
  }

  /** The memory folder to sync: set and present. A missing folder (an unplugged drive) is not read as "all notes deleted". */
  private memoryRoot(): string | undefined {
    const root = this.host.roots().memory;
    try { return root && statSync(root).isDirectory() ? root : undefined; } catch { return undefined; }
  }

  /** This PC's config in its portable form. */
  private async snapshot(): Promise<{ bundle: ConfigBundle; hash: string }> {
    const config = vscode.workspace.getConfiguration('dsh');
    const accounts = this.host.accounts();
    const settings: Record<string, unknown> = {};
    for (const key of SYNCED_SETTINGS) {
      let value = config.inspect(key)?.globalValue;
      if (value === undefined) continue;
      if (key === 'models') value = portableModels(value, accounts);
      if (key === 'mcpServers') value = stripMcpSecrets(value);
      settings[key] = value;
    }
    const memory = this.memoryRoot();
    const roots = { ...this.host.roots(), memory };
    const files = await collectFiles(roots);
    // Without a memory folder here, this PC leaves GitHub's memory as it is rather than deleting it.
    if (!memory) for (const [path, file] of Object.entries((await this.readBase())?.files || {})) if (path.startsWith('memory/')) files[path] = file;
    const bundle: ConfigBundle = { format: 'dsh-config', version: 1, settings, files, toolpacks: await collectToolpacks(roots.toolpacks) };
    return { bundle, hash: hashBundle(bundle) };
  }

  private get baseFile(): string { return join(this.context.globalStorageUri.fsPath, BASE_FILE); }

  private async readBase(): Promise<ConfigBundle | undefined> {
    try { return parseBundle(await fs.readFile(this.baseFile, 'utf8')); } catch { return undefined; }
  }

  /** Remembers what GitHub and this PC hold after a sync. */
  private async record(remote: ConfigBundle, localHash: string): Promise<void> {
    await fs.mkdir(this.context.globalStorageUri.fsPath, { recursive: true });
    await fs.writeFile(this.baseFile, serializeBundle(remote));
    await this.save({ remoteHash: hashBundle(remote), localHash, lastSync: Date.now(), memoryRoot: this.memoryRoot() });
    this.conflict = undefined;
    this.notified = '';
  }

  private async upload(clone: SyncClone, auth: GitAuth, bundle: ConfigBundle, localHash: string, before: ConfigBundle | undefined): Promise<void> {
    await clone.write(bundleToTree(bundle), describeChanges(before, bundle, hostname()), auth);
    await this.record(bundle, localHash);
  }

  private async download(bundle: ConfigBundle): Promise<void> {
    const failures = await this.apply(bundle);
    await this.record(bundle, (await this.snapshot()).hash);
    if (failures.length) throw new Error(`Downloaded, but some toolpacks could not be installed: ${failures.join(' ')}`);
  }

  /** Applies a merge of both PCs' edits here, then uploads it. */
  private async merge(clone: SyncClone, auth: GitAuth, bundle: ConfigBundle, remote: ConfigBundle | undefined): Promise<void> {
    const failures = await this.apply(bundle);
    await this.upload(clone, auth, bundle, (await this.snapshot()).hash, remote);
    this.host.log('Config sync: merged edits from this PC and GitHub.');
    if (failures.length) throw new Error(`Merged, but some toolpacks could not be installed: ${failures.join(' ')}`);
  }

  /** Makes this PC's settings, rules, skills, toolpacks and memory match `bundle`. Returns toolpacks that failed to install. */
  private async apply(bundle: ConfigBundle): Promise<string[]> {
    this.applying = true;
    try {
      const config = vscode.workspace.getConfiguration('dsh');
      const accounts = this.host.accounts();
      for (const key of SYNCED_SETTINGS) {
        const current = config.inspect(key)?.globalValue;
        let value = bundle.settings[key];
        if (key === 'models') value = localModels(value, accounts);
        if (key === 'mcpServers') value = restoreMcpSecrets(value, current);
        if (stableJson(value) !== stableJson(current)) await config.update(key, value, vscode.ConfigurationTarget.Global);
      }
      const roots = this.host.roots();
      let memory = this.memoryRoot();
      if (!memory && hasMemory(bundle)) {
        // A PC with no memory folder (or a missing one) gets GitHub's memory in a folder of its own.
        memory = roots.memory && !existsSync(roots.memory) ? roots.memory : await this.host.adoptMemoryRoot();
        await fs.mkdir(memory, { recursive: true });
      }
      await applyFiles({ ...roots, memory }, memory ? bundle.files : withoutMemory(bundle).files);
      const failures = await this.applyToolpacks(roots.toolpacks, bundle.toolpacks);
      await this.host.applied();
      return failures;
    } finally { this.applying = false; }
  }

  private async applyToolpacks(dir: string, remote: ConfigBundle['toolpacks']): Promise<string[]> {
    const failures: string[] = [];
    const local = await collectToolpacks(dir);
    for (const { id } of this.host.toolpacks.list()) {
      if (Object.hasOwn(remote, id)) continue;
      try { await this.host.toolpacks.remove(id); } catch (error) { failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    for (const [id, pack] of Object.entries(remote)) {
      try {
        if (local[id]?.source !== pack.source) {
          const staging = join(tmpdir(), `dsh-sync-${randomUUID()}`);
          await fs.mkdir(staging, { recursive: true });
          try {
            await fs.writeFile(join(staging, `${id}.ts`), pack.source);
            await this.host.toolpacks.add(join(staging, `${id}.ts`));
          } finally { await fs.rm(staging, { recursive: true, force: true }); }
        }
        if (this.host.toolpacks.list().find(item => item.id === id)?.enabled !== pack.enabled) await this.host.toolpacks.setEnabled(id, pack.enabled);
        // After install, so the pack's own meta.json says which files it syncs.
        if (pack.settings) await applyToolpackSettings(dir, id, pack.settings);
      } catch (error) { failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return failures;
  }

  /** The config from the earlier gist-based sync, if this account has one. */
  private async legacyGist(token: string): Promise<ConfigBundle | undefined> {
    try {
      const found = await findConfigGist(token);
      return found ? (await readConfigGist(token, found.id))?.bundle : undefined;
    } catch (error) {
      this.host.log(`Config sync: could not read the earlier gist config: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /**
   * Signs in, finds or creates the private dsh-sync repository, and combines this PC's config with what is there
   * (or with a config from the earlier gist sync). Items that differ on both sides are asked about once.
   */
  public connect(): Promise<unknown> {
    return this.run('connecting', async () => {
      const auth = await this.session(true);
      const repo = await findSyncRepo(auth.token, auth.login) ?? await createSyncRepo(auth.token);
      await this.save({ repo: repo.fullName, repoUrl: repo.url, cloneUrl: repo.cloneUrl, remoteHash: undefined, localHash: undefined, memoryRoot: undefined });
      await fs.rm(this.baseFile, { force: true });
      try {
        const clone = await this.clone();
        const stored = treeToBundle(await clone.read(auth));
        const remote = stored ?? await this.legacyGist(auth.token);
        const local = await this.snapshot();
        if (!remote) { await this.upload(clone, auth, local.bundle, local.hash, undefined); return; }
        let combined = mergeBundles(EMPTY, local.bundle, remote);
        if (combined.conflicts.length) {
          const items = combined.conflicts;
          const choice = await vscode.window.showWarningMessage(`Your GitHub sync already has DSH config from another computer, and ${items.length} item${items.length === 1 ? '' : 's'} differ from this PC.`, {
            modal: true,
            detail: `Different on each: ${items.slice(0, 6).join(', ')}${items.length > 6 ? ` and ${items.length - 6} more` : ''}. Everything else from both, including all memory notes, is combined. Choose which version of these to keep.`,
          }, 'Keep GitHub copy', 'Keep this PC');
          if (!choice) throw new Error('Connecting was cancelled. Nothing was changed.');
          if (choice === 'Keep this PC') combined = mergeBundles(EMPTY, local.bundle, remote, 'local');
        }
        await this.merge(clone, auth, combined.bundle, stored);
      } catch (error) {
        // A failed or cancelled first sync leaves this PC unconnected, so the next attempt starts over.
        await this.save({ repo: undefined, repoUrl: undefined, cloneUrl: undefined });
        throw error;
      }
    });
  }

  public uploadNow(): Promise<unknown> {
    return this.run('uploading', async () => {
      const auth = await this.session(true);
      const clone = await this.clone();
      const remote = treeToBundle(await clone.read(auth));
      const local = await this.snapshot();
      await this.upload(clone, auth, local.bundle, local.hash, remote);
    });
  }

  public downloadNow(confirmed = false): Promise<unknown> {
    return this.run('downloading', async () => {
      const auth = await this.session(true);
      const clone = await this.clone();
      const remote = treeToBundle(await clone.read(auth));
      if (!remote) throw new Error('The sync repository is empty. Upload to fill it.');
      const choice = confirmed ? 'Download' : await vscode.window.showWarningMessage('Replace this PC\'s DSH config with the GitHub copy?', {
        modal: true, detail: 'Global rules, skills, toolpacks, memory and DSH settings are replaced. API keys and MCP secrets on this PC are kept.',
      }, 'Download');
      if (choice === 'Download') await this.download(remote);
    });
  }

  /** Settles a conflict: both PCs' other edits are kept, and items both changed come from the side chosen. */
  public resolve(prefer: 'local' | 'remote'): Promise<unknown> {
    return this.run(prefer === 'local' ? 'uploading' : 'downloading', () => this.withRetry(async () => {
      const auth = await this.session(true);
      const clone = await this.clone();
      const remote = treeToBundle(await clone.read(auth));
      const [local, base] = await Promise.all([this.snapshot(), this.readBase()]);
      if (!remote) { await this.upload(clone, auth, local.bundle, local.hash, undefined); return; }
      await this.merge(clone, auth, mergeBundles(base ?? EMPTY, local.bundle, remote, prefer).bundle, remote);
    }));
  }

  /** Stops syncing on this PC. The repository stays on GitHub. */
  public async disconnect(): Promise<void> {
    await this.queue;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.error = undefined;
    this.conflict = undefined;
    await fs.rm(this.baseFile, { force: true });
    await fs.rm(join(this.context.globalStorageUri.fsPath, CLONE_DIR), { recursive: true, force: true });
    await this.context.globalState.update(STATE_KEY, { auto: this.saved.auto });
    this.post();
  }

  public async setAuto(enabled: boolean): Promise<void> {
    await this.save({ auto: enabled === true });
    this.post();
    if (enabled) this.schedule();
  }

  /** Enables automatic sync once toolpacks are loaded, then runs the startup check. */
  public start(): void {
    this.ready = true;
    this.check();
    this.poll ??= setInterval(() => this.check(true), POLL_INTERVAL);
  }

  /** Called when synced config or memory changes on this PC. Commits after a short pause if auto sync is on. */
  public schedule(): void {
    const state = this.saved;
    if (!this.ready || this.applying || !state.auto || !state.repo || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // Toolpack status changes call this often; only real config changes reach GitHub.
      this.snapshot().then(local => {
        if (local.hash !== this.saved.localHash || this.memoryRoot() !== this.saved.memoryRoot) void this.run('checking', () => this.withRetry(() => this.sync()), true);
      }).catch(error => this.host.log(`Config sync: ${error instanceof Error ? error.message : String(error)}`));
    }, UPLOAD_DELAY);
  }

  /** Startup and focus check: pulls edits from other PCs and pushes edits made here. */
  public check(fromFocus = false): void {
    const state = this.saved;
    if (!this.ready || !state.auto || !state.repo) return;
    if (fromFocus && Date.now() - this.lastCheck < FOCUS_CHECK_INTERVAL) return;
    void this.run('checking', () => this.withRetry(() => this.sync()), true);
  }

  /** Another PC pushed between this read and this write: read again and redo the decision once. */
  private async withRetry(task: () => Promise<void>): Promise<void> {
    try { await task(); } catch (error) { if (error instanceof PushRejected) await task(); else throw error; }
  }

  private async sync(): Promise<void> {
    this.lastCheck = Date.now();
    const state = this.saved;
    if (!state.repo) return;
    const auth = await this.session(false);
    const clone = await this.clone();
    const remote = treeToBundle(await clone.read(auth));
    const local = await this.snapshot();
    if (!remote) { await this.upload(clone, auth, local.bundle, local.hash, undefined); this.error = undefined; return; }
    const remoteHash = hashBundle(remote);
    if (remoteHash === local.hash) {
      const settled = state.remoteHash === remoteHash && state.localHash === local.hash && !this.conflict && existsSync(this.baseFile);
      if (!settled || this.memoryRoot() !== state.memoryRoot) await this.record(remote, local.hash);
      this.error = undefined;
      return;
    }
    let base = await this.readBase();
    // Memory now points at another folder: merge it with GitHub's notes rather than reading the switch as deletions.
    const memoryMoved = this.memoryRoot() !== state.memoryRoot && !!this.memoryRoot();
    if (memoryMoved && base) base = withoutMemory(base);
    const remoteChanged = memoryMoved || remoteHash !== state.remoteHash;
    const localChanged = memoryMoved || local.hash !== state.localHash;
    if (remoteChanged && !localChanged) await this.download(remote);
    else if (localChanged && !remoteChanged) await this.upload(clone, auth, local.bundle, local.hash, remote);
    else if (remoteChanged && localChanged) {
      // Both sides changed: edits to different items merge; the same item changed on both waits for a choice (memory notes keep both).
      const merged = base && mergeBundles(base, local.bundle, remote);
      if (merged && !merged.conflicts.length) await this.merge(clone, auth, merged.bundle, remote);
      else this.raiseConflict(merged ? merged.conflicts : []);
      return;
    }
    this.error = undefined;
  }

  /** Shows the conflict on the Sync page, and once as a notification. */
  private raiseConflict(items: string[]): void {
    this.conflict = items;
    const key = items.join('\n') || '*';
    if (key === this.notified) return;
    this.notified = key;
    const detail = items.length ? `Changed on both: ${items.slice(0, 5).join(', ')}${items.length > 5 ? ` and ${items.length - 5} more` : ''}.` : 'DSH config changed both on this PC and on GitHub.';
    void vscode.window.showWarningMessage(`DSH sync is paused. ${detail}`, 'Keep GitHub copy', 'Keep this PC').then(choice => {
      if (choice === 'Keep GitHub copy') void this.resolve('remote');
      else if (choice === 'Keep this PC') void this.resolve('local');
    });
  }
}
