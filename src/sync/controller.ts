import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { SidebarSync } from '../sidebar/view';
import {
  AccountRef, ConfigBundle, SYNCED_SETTINGS, SyncRoots, applyFiles, collectFiles, collectToolpacks, findConfigGist, hashBundle,
  localModels, portableModels, readConfigGist, restoreMcpSecrets, stableJson, stripMcpSecrets, writeConfigGist,
} from './configSync';

const STATE_KEY = 'dsh.ide.configSync.v1';
/** Local edits are batched so a burst of saves makes one upload. */
const UPLOAD_DELAY = 5000;
/** Regaining focus looks for edits from other PCs at most this often. */
const FOCUS_CHECK_INTERVAL = 5 * 60_000;

interface SyncState {
  gistId?: string;
  gistUrl?: string;
  account?: string;
  auto: boolean;
  /** Hash of the GitHub copy as of the last upload or download. */
  remoteHash?: string;
  /** Hash of this PC's config right after the last upload or download. */
  localHash?: string;
  lastSync?: number;
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
  log(line: string): void;
  post(state: SidebarSync): void;
  /** Called after a download so views that do not watch settings can refresh. */
  applied(): Promise<void>;
}

/** Keeps global rules, skills, toolpacks and `dsh.*` user settings in a secret GitHub gist. */
export class ConfigSync implements vscode.Disposable {
  private queue: Promise<unknown> = Promise.resolve();
  private busy?: SidebarSync['busy'];
  private error?: string;
  private timer?: NodeJS.Timeout;
  private applying = false;
  private ready = false;
  private lastCheck = 0;

  public constructor(private readonly context: vscode.ExtensionContext, private readonly host: ConfigSyncHost) {}

  public dispose(): void { if (this.timer) clearTimeout(this.timer); }

  private get saved(): SyncState { return { auto: true, ...this.context.globalState.get<Partial<SyncState>>(STATE_KEY, {}) }; }
  private async save(patch: Partial<SyncState>): Promise<void> { await this.context.globalState.update(STATE_KEY, { ...this.saved, ...patch }); }

  public get gistUrl(): string | undefined { return this.saved.gistUrl; }

  public post(): void {
    const state = this.saved;
    this.host.post({ connected: !!state.gistId, account: state.account, gistUrl: state.gistUrl, auto: state.auto, lastSync: state.lastSync, busy: this.busy, error: this.error });
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

  private async session(interactive: boolean): Promise<vscode.AuthenticationSession> {
    const session = await vscode.authentication.getSession('github', ['gist'], interactive ? { createIfNone: true } : { silent: true });
    if (!session) throw new Error('Sign in to GitHub on the Sync page to keep syncing.');
    if (session.account.label !== this.saved.account) await this.save({ account: session.account.label });
    return session;
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
    const roots = this.host.roots();
    const bundle: ConfigBundle = { format: 'dsh-config', version: 1, settings, files: await collectFiles(roots), toolpacks: await collectToolpacks(roots.toolpacks) };
    return { bundle, hash: hashBundle(bundle) };
  }

  private async upload(token: string, bundle: ConfigBundle, hash: string): Promise<void> {
    const state = this.saved;
    const gist = await writeConfigGist(token, state.gistId, bundle) ?? await writeConfigGist(token, undefined, bundle);
    await this.save({ gistId: gist!.id, gistUrl: gist!.url, remoteHash: hash, localHash: hash, lastSync: Date.now() });
  }

  private async download(bundle: ConfigBundle, remoteHash: string, gist: { id: string; url: string }): Promise<void> {
    this.applying = true;
    const failures: string[] = [];
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
      await applyFiles(roots, bundle.files);
      failures.push(...await this.applyToolpacks(roots.toolpacks, bundle.toolpacks));
      await this.host.applied();
    } finally { this.applying = false; }
    const local = await this.snapshot();
    await this.save({ gistId: gist.id, gistUrl: gist.url, remoteHash, localHash: local.hash, lastSync: Date.now() });
    if (failures.length) throw new Error(`Downloaded, but some toolpacks could not be installed: ${failures.join(' ')}`);
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
      } catch (error) { failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return failures;
  }

  /** Signs in, then links an existing config gist or creates one from this PC. */
  public connect(): Promise<unknown> {
    return this.run('connecting', async () => {
      const { accessToken } = await this.session(true);
      const found = await findConfigGist(accessToken);
      const local = await this.snapshot();
      if (!found) { await this.upload(accessToken, local.bundle, local.hash); return; }
      const remote = await readConfigGist(accessToken, found.id);
      if (!remote) { await this.upload(accessToken, local.bundle, local.hash); return; }
      const remoteHash = hashBundle(remote.bundle);
      if (remoteHash === local.hash) { await this.save({ gistId: found.id, gistUrl: found.url, remoteHash, localHash: local.hash, lastSync: Date.now() }); return; }
      const choice = await vscode.window.showWarningMessage('Your GitHub account already has a DSH config.', {
        modal: true, detail: `It was last updated ${new Date(remote.gist.updatedAt).toLocaleString()}. Download replaces this PC's global rules, skills, toolpacks and DSH settings. Upload replaces the GitHub copy with this PC's config.`,
      }, 'Download', 'Upload this PC');
      if (choice === 'Download') await this.download(remote.bundle, remoteHash, remote.gist);
      else if (choice === 'Upload this PC') await this.upload(accessToken, local.bundle, local.hash);
    });
  }

  public uploadNow(): Promise<unknown> {
    return this.run('uploading', async () => {
      const { accessToken } = await this.session(true);
      const local = await this.snapshot();
      await this.upload(accessToken, local.bundle, local.hash);
    });
  }

  public downloadNow(confirmed = false): Promise<unknown> {
    return this.run('downloading', async () => {
      const { accessToken } = await this.session(true);
      const gistId = this.saved.gistId;
      const remote = gistId ? await readConfigGist(accessToken, gistId) : undefined;
      if (!remote) throw new Error('The GitHub config gist no longer exists. Upload to create a new one.');
      const choice = confirmed ? 'Download' : await vscode.window.showWarningMessage('Replace this PC\'s DSH config with the GitHub copy?', {
        modal: true, detail: 'Global rules, skills, toolpacks and DSH settings are replaced. API keys and MCP secrets on this PC are kept.',
      }, 'Download');
      if (choice === 'Download') await this.download(remote.bundle, hashBundle(remote.bundle), remote.gist);
    });
  }

  /** Forgets the gist on this PC. The gist itself stays on GitHub. */
  public async disconnect(): Promise<void> {
    await this.queue;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.error = undefined;
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
  }

  /** Called when synced config changes on this PC. Uploads after a short pause if auto sync is on. */
  public schedule(): void {
    const state = this.saved;
    if (!this.ready || this.applying || !state.auto || !state.gistId || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // Toolpack status changes call this often; only real config changes reach GitHub.
      this.snapshot().then(local => {
        if (local.hash !== this.saved.localHash) void this.run('checking', () => this.sync(), true);
      }).catch(error => this.host.log(`Config sync: ${error instanceof Error ? error.message : String(error)}`));
    }, UPLOAD_DELAY);
  }

  /** Startup and focus check: pulls edits from other PCs and pushes edits made here. */
  public check(fromFocus = false): void {
    const state = this.saved;
    if (!this.ready || !state.auto || !state.gistId) return;
    if (fromFocus && Date.now() - this.lastCheck < FOCUS_CHECK_INTERVAL) return;
    void this.run('checking', () => this.sync(), true);
  }

  private async sync(): Promise<void> {
    this.lastCheck = Date.now();
    const state = this.saved;
    if (!state.gistId) return;
    const { accessToken } = await this.session(false);
    const [remote, local] = await Promise.all([readConfigGist(accessToken, state.gistId), this.snapshot()]);
    if (!remote) { await this.upload(accessToken, local.bundle, local.hash); this.error = undefined; return; }
    const remoteHash = hashBundle(remote.bundle);
    if (remoteHash === local.hash) {
      await this.save({ remoteHash, localHash: local.hash, gistUrl: remote.gist.url });
      this.error = undefined;
      return;
    }
    const remoteChanged = remoteHash !== state.remoteHash;
    const localChanged = local.hash !== state.localHash;
    if (remoteChanged && !localChanged) await this.download(remote.bundle, remoteHash, remote.gist);
    else if (localChanged && !remoteChanged) await this.upload(accessToken, local.bundle, local.hash);
    else if (remoteChanged && localChanged) {
      // Both sides changed; never overwrite either one without asking.
      void vscode.window.showWarningMessage('DSH config changed both on this PC and on GitHub.', 'Download', 'Upload this PC').then(choice => {
        if (choice === 'Download') void this.downloadNow(true);
        else if (choice === 'Upload this PC') void this.uploadNow();
      });
      return;
    }
    this.error = undefined;
  }
}
