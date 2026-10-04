import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { AccountRegistry, ModelEntry, ModelRegistry, ResolvedModel } from './accounts';
import { OAuthCliAccount, OAuthCliAccounts, OAuthCliProvider, setDetectedCliCommand } from './accounts/oauthCli';
import { WindowsDependencies } from './runtime/dependencies';
import { ReviewController, ReviewProposal } from './review/controller';
import { DelegateAgentInfo, DelegateHost, DelegateResult, DelegateToolInfo } from './delegate/host';
import { InstructionItem, InstructionRoots, listInstructions, locateInstruction, readInstruction, removeInstruction, saveInstruction } from './instructions/store';
import { shareInstructions } from './instructions/share';
import { chatTitlePrompt, cleanChatTitle, firstMessageTitle } from './runtime/naming';
import { ToolpackRegistry } from './toolpacks/registry';
import { currentVersion, installVersion, latestVersion, updatedRoot } from './update/dshUpdate';
import { installExtensionRelease, latestExtensionRelease } from './update/extensionUpdate';
import { planUpdates, UpdateOffer, UpdatePlan } from './update/plan';
import { compareVersions } from './update/version';
import { formatAnswers, parseQuestions } from './sidebar/questions';
import { delegationInstructions, isDelegationTool, isNativeSubagentTool } from './runtime/delegation';
import { AcpRuntime, RuntimeEvent } from './runtime/acp';
import { OAuthCliRuntime } from './runtime/oauthCli';
import { MirrorChange, WorkspaceMirror } from './runtime/shadow';
import { DshSidebarProvider, SidebarWebviewMessage } from './sidebar/provider';
import { ApprovalMode, CursorAccountState, SidebarAccessibility, SidebarFeatureKey, SidebarFeatures, SidebarImage, SidebarNameModel, SidebarTimelineItem, SidebarSubagent, defaultFeatures, normalizeAccessibility } from './sidebar/view';

interface SessionRecord {
  id: string;
  mirrorId: string;
  name: string;
  /** The user renamed this chat, so automatic titles must not replace the name. */
  renamed?: boolean;
  modelName: string;
  provider: string;
  backend: string;
  accountId: string;
  cliSessionId?: string;
  runtimeId?: string;
  pendingMirror?: boolean;
  /** The agent edits the real workspace instead of a private copy (dsh.runtime.mirror off when the chat was created). */
  direct?: boolean;
  effort?: string;
  updatedAt: number;
}

const SESSIONS_KEY = 'dsh.ide.sessions.v1';
const SELECTED_MODEL_KEY = 'dsh.ide.selectedModel.v1';
const ACTIVE_SESSION_KEY = 'dsh.ide.activeSession.v1';
const CURSOR_MODELS_KEY = 'dsh.ide.cursorModels.v1';
const MODEL_CHOICES_KEY = 'dsh.ide.modelChoices.v1';
const APPROVAL_KEY = 'dsh.ide.approvalMode.v1';
const TRANSCRIPTS_KEY = 'dsh.ide.transcripts.v1';
const TIMELINES_KEY = 'dsh.ide.timelines.v1';
type SavedTimeline = { timeline: SidebarTimelineItem[]; subagents: Record<string, SidebarSubagent> };
const PROVIDER_USAGE_URLS = new Map([
  ['codex-cli', 'https://chatgpt.com/settings/usage?tab=overview'],
  ['claude-cli', 'https://claude.ai/settings/usage'],
  ['cursor-acp', 'https://cursor.com/dashboard?tab=usage'],
  ['deepseek-official', 'https://platform.deepseek.com/usage'],
  ['openrouter', 'https://openrouter.ai/activity'],
]);
const RISKY_ACTION = /\brm\s+-[a-z]*[rf]|\bsudo\b|\bchmod\b|\bchown\b|\bmkfs\b|\bdd\s+if=|\bformat\s+[a-z]:|\bdel\s+\/|Remove-Item|git\s+(push|reset\s+--hard|clean|checkout\s+--)|\b(curl|wget|iwr|Invoke-WebRequest)\b|\|\s*(sh|bash|iex)\b|\b(npm|pip|pnpm|yarn)\s+(publish|install\s+-g)|\bkill(all)?\b|\bshutdown\b|\.env\b|\.ssh|credentials|\.\.[\\/]|(^|\s)(\/|~|[A-Za-z]:[\\/])/i;
const isRiskyAction = (description: string): boolean => RISKY_ACTION.test(description);
const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MAX_IMAGES = 8;
const MAX_IMAGE_BASE64 = 14_000_000;
type ModelChoice = { speed?: string; effort?: string };
/** Customize page switches and the `dsh` settings that store them. */
const FEATURE_SETTINGS: Record<SidebarFeatureKey, string> = {
  activityRail: 'features.activityRail', autoName: 'features.autoName', shareRules: 'features.shareRules', editorContext: 'features.editorContext',
  reduceMotion: 'features.reduceMotion', updateChecks: 'updates.check', mirror: 'runtime.mirror',
};
type ResolvedRoute = ResolvedModel | { model: ModelEntry } | { model: ModelEntry; oauthAccount: OAuthCliAccount };

function isOAuthProvider(value: string): value is OAuthCliProvider { return value === 'codex-cli' || value === 'claude-cli'; }
function runtimeLabel(provider: string): string { return provider === 'cursor-acp' ? 'Cursor' : provider === 'codex-cli' ? 'Codex' : provider === 'claude-cli' ? 'Claude' : 'DSH'; }

interface SubagentProfile { name: string; description?: string; model: string; effort?: string; speed?: string; mode: 'read-only' | 'edit'; enabled?: boolean }
interface Actor { owner: string; label: string; readOnly: boolean }
interface ToolInfo { tool: string; input: Record<string, unknown>; autoAllowEdits?: boolean }
interface ChildRun {
  parent: Chat;
  owner: string;
  label: string;
  readOnly: boolean;
  changed: Set<string>;
  outOfScope: Set<string>;
  files: string[];
  runtimeKey?: string;
  sessionId?: string;
  onUpdate?(update: Record<string, unknown>): void;
  cancel(): void;
}
const PARENT: Actor = { owner: 'parent', label: '', readOnly: false };
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const DELEGATE_SERVER = 'dsh-delegate';

interface Chat {
  record: SessionRecord;
  mirror: WorkspaceMirror;
  review: ReviewController;
  cli: OAuthCliRuntime;
  running: boolean;
  cancelRequested: boolean;
  queue: { prompt: string; images: { path: string; mimeType: string; data: string; name: string }[] }[];
  turnEntryId: string;
  segment: number;
  startedTools: Set<string>;
  subagentIds: Set<string>;
  delegationToolIds: Set<string>;
  subagentText: Map<string, string>;
  turnReply: string;
  handoffPending: boolean;
  ownerId: string;
  runtime?: AcpRuntime;
  runtimeKey?: string;
  locks: Map<string, { owner: string; label: string }>;
  children: Set<ChildRun>;
}

class ExtensionHost implements vscode.Disposable {
  private readonly dependencies: WindowsDependencies;
  private nodeReady?: Promise<string>;
  private updateCheck?: Promise<UpdateOffer & { failures: string[] }>;
  private updateInstall?: Promise<unknown>;
  private updateRequired?: string;
  private reloadPending = false;
  private readonly providerInstalls = new Set<string>();
  private readonly providerErrors = new Map<string, string>();
  private readonly output = vscode.window.createOutputChannel('DeepSeek Harness');
  private readonly accounts: AccountRegistry;
  private readonly oauthAccounts: OAuthCliAccounts;
  private readonly models: ModelRegistry;
  private readonly sidebar: DshSidebarProvider;
  private readonly status: vscode.StatusBarItem;
  private readonly runtimes = new Map<string, AcpRuntime>();
  private readonly chats = new Map<string, Chat>();
  private readonly chatLoads = new Map<string, Promise<Chat>>();
  private readonly promptStarts = new Map<string, Promise<void>>();
  private readonly deletedSessions = new Set<string>();
  private readonly childRuns = new Set<ChildRun>();
  /** Text listeners for tool-less ACP runs such as chat naming, keyed by `${runtimeKey}\n${sessionId}`. */
  private readonly oneShots = new Map<string, (update: Record<string, unknown>) => void>();
  private readonly delegateHost = new DelegateHost();
  private readonly toolpacks: ToolpackRegistry;
  private active?: SessionRecord;
  private selectedModel: string;
  private modelChoices: Record<string, ModelChoice>;
  private approvalMode: ApprovalMode;
  private readonly transcripts = new Map<string, { role: 'user' | 'assistant'; text: string }[]>();
  private readonly timelines: Record<string, SavedTimeline>;
  private timelineTimer?: NodeJS.Timeout;
  private cursorModels: ModelEntry[];
  private cursorAccount: CursorAccountState = { connected: false, label: 'Not connected' };
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.dependencies = new WindowsDependencies(context.globalStorageUri.fsPath,
      () => vscode.workspace.getConfiguration('dsh').get<string>('runtime.nodePath'),
      provider => vscode.workspace.getConfiguration('dsh').get<string>(provider === 'codex-cli' ? 'runtime.codexPath' : provider === 'claude-cli' ? 'runtime.claudePath' : 'runtime.cursorAgentPath'));
    this.accounts = new AccountRegistry(context);
    this.oauthAccounts = new OAuthCliAccounts(context);
    this.models = new ModelRegistry(context, this.accounts);
    this.cursorModels = context.workspaceState.get<ModelEntry[]>(CURSOR_MODELS_KEY, []);
    for (const [id, items] of Object.entries(context.workspaceState.get<Record<string, { role: 'user' | 'assistant'; text: string }[]>>(TRANSCRIPTS_KEY, {}))) this.transcripts.set(id, items);
    this.selectedModel = context.workspaceState.get<string>(SELECTED_MODEL_KEY) || this.models.list(true)[0]?.name || '';
    this.modelChoices = context.workspaceState.get<Record<string, ModelChoice>>(MODEL_CHOICES_KEY, {});
    const savedApproval = context.workspaceState.get<ApprovalMode>(APPROVAL_KEY);
    this.approvalMode = savedApproval === 'auto' || savedApproval === 'full' ? savedApproval : 'ask';
    this.timelines = context.workspaceState.get<Record<string, SavedTimeline>>(TIMELINES_KEY, {});
    for (const saved of Object.values(this.timelines)) for (const item of saved.timeline) if (item.kind === 'question' && item.status === 'pending') item.status = 'skipped';
    this.toolpacks = new ToolpackRegistry({
      dir: join(context.globalStorageUri.fsPath, 'toolpacks'),
      workerPath: join(context.extensionPath, 'dist', 'toolpack-worker.js'),
      nodePath: () => vscode.workspace.getConfiguration('dsh').get<string>('runtime.nodePath') || undefined,
      compile: async source => (await (await import('esbuild')).transform(source, { loader: 'ts', format: 'cjs', target: 'node20' })).code,
    });
    this.sidebar = new DshSidebarProvider(context.extensionUri, message => this.onSidebarMessage(message), (id, timeline, subagents) => {
      if (this.deletedSessions.has(id)) return;
      this.timelines[id] = { timeline, subagents };
      if (!this.timelineTimer) this.timelineTimer = setTimeout(() => {
        this.timelineTimer = undefined;
        void this.context.workspaceState.update(TIMELINES_KEY, this.timelines);
      }, 300);
    });
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    this.status.command = 'dsh.continue';
    this.status.text = '$(hubot) DSH';
    this.status.tooltip = 'DeepSeek Harness: click to continue chat';
    this.status.show();
    this.disposables.push(
      this.output, this.status, this.sidebar,
      { dispose: () => { for (const runtime of this.runtimes.values()) runtime.dispose(); this.runtimes.clear(); this.delegateHost.dispose(); void this.toolpacks.dispose(); } },
      this.toolpacks.onChange(() => this.postToolpacks()),
      vscode.window.registerWebviewViewProvider(DshSidebarProvider.viewType, this.sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('dsh.models')) this.refreshModels();
        if (event.affectsConfiguration('dsh.subagents')) this.refreshSubagents();
        if (['dsh.features', 'dsh.nameModel', 'dsh.updates.check', 'dsh.accessibility'].some(key => event.affectsConfiguration(key))) this.refreshCustomize();
      }),
      // Before the write, so a watcher scan cannot see the save first; after it, for format-on-save output.
      vscode.workspace.onWillSaveTextDocument(event => this.adoptSave(event.document)),
      vscode.workspace.onDidSaveTextDocument(document => this.adoptSave(document)),
    );
    this.registerCommands();
    this.delegateHost.start({
      describe: () => this.subagentInfos(),
      tools: () => this.toolpackTools(),
      call: (owner, tool, args) => this.handleDelegateCall(owner, tool, args),
    }).catch(error => this.output.appendLine(`Subagent bridge failed to start: ${String(error)}`));
    const updateTimer = setTimeout(() => { void this.checkUpdates(); }, 5000);
    this.disposables.push({ dispose: () => clearTimeout(updateTimer) });
    this.ensureNode().then(async () => { await this.refreshDependencies(); await this.toolpacks.start(); }).catch(error => {
      this.output.appendLine(`Dependency setup failed: ${String(error)}`);
      void vscode.window.showErrorMessage(`DSH setup failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.sidebar.postMessage({ type: 'approvalState', mode: this.approvalMode });
    this.refreshCustomize();
    this.refreshModels();
    this.refreshSessions();
    void this.refreshAccount();
    void this.refreshAccounts();
  }

  private get chat(): Chat | undefined { return this.active ? this.chats.get(this.active.id) : undefined; }

  private ensureNode(): Promise<string> {
    if (!this.nodeReady) {
      this.nodeReady = Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'DSH: checking Node.js and npm…' }, () => this.dependencies.ensureNode())).catch(error => { this.nodeReady = undefined; throw error; });
    }
    return this.nodeReady;
  }

  private async refreshDependencies(): Promise<void> {
    const providers = await Promise.all(['codex-cli', 'claude-cli', 'cursor-acp'].map(async provider => {
      let installed = false;
      try {
        const command = await this.dependencies.providerCommand(provider);
        installed = !!command;
        if (command && isOAuthProvider(provider)) setDetectedCliCommand(provider, command);
      } catch (error) { this.providerErrors.set(provider, error instanceof Error ? error.message : String(error)); }
      return { provider, installed, installing: this.providerInstalls.has(provider), error: this.providerErrors.get(provider) };
    }));
    this.sidebar.postMessage({ type: 'dependencyState', providers });
  }

  private async installProvider(provider: string): Promise<void> {
    if (!['codex-cli', 'claude-cli', 'cursor-acp'].includes(provider)) throw new Error('Unsupported provider installation.');
    if (this.providerInstalls.has(provider)) return;
    this.providerInstalls.add(provider);
    this.providerErrors.delete(provider);
    await this.refreshDependencies();
    try {
      await this.ensureNode();
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `DSH: installing ${runtimeLabel(provider)}…` }, () => this.dependencies.installProvider(provider));
    } catch (error) {
      this.providerErrors.set(provider, error instanceof Error ? error.message : String(error));
      throw error;
    } finally { this.providerInstalls.delete(provider); await this.refreshDependencies(); }
  }
  private get mirror(): WorkspaceMirror | undefined { return this.chat?.mirror; }
  private get review(): ReviewController | undefined { return this.chat?.review; }
  private get running(): boolean { return !!this.chat?.running; }

  private chatForRuntime(runtimeId: string, key: string): Chat | undefined {
    return [...this.chats.values()].find(chat => chat.runtimeKey === key && this.rid(chat.record) === runtimeId);
  }

  private runtimeFor(key: string): AcpRuntime {
    const existing = this.runtimes.get(key);
    if (existing) return existing;
    const runtime = new AcpRuntime(this.output, params => this.requestPermission(params, key), (method, params) => this.handleCursorRequest(method, params));
    this.runtimes.set(key, runtime);
    runtime.onUpdate(event => this.onRuntimeUpdate(event, key));
    runtime.onState(state => {
      if (state === 'stopped' && this.runtimes.get(key) === runtime) this.runtimes.delete(key);
      this.updateStatus();
    });
    return runtime;
  }

  private async releaseRuntime(key: string | undefined): Promise<void> {
    if (!key) return;
    if ([...this.chats.values()].some(chat => chat.runtimeKey === key) || [...this.childRuns].some(run => run.runtimeKey === key)) return;
    const runtime = this.runtimes.get(key);
    if (!runtime) return;
    this.runtimes.delete(key);
    await runtime.stop();
    runtime.dispose();
  }

  private async unloadChat(id: string): Promise<void> {
    const chat = this.chats.get(id);
    if (!chat) return;
    this.chats.delete(id);
    if (this.active?.id === id) this.active = undefined;
    if (chat.runtime) await chat.runtime.closeSession(this.rid(chat.record)).catch(() => undefined);
    chat.review.dispose(); chat.mirror.dispose();
    await this.releaseRuntime(chat.runtimeKey);
  }

  private trimChats(): void {
    // Bound retained runtimes/watchers while keeping recent navigation warm.
    const idle = [...this.chats.values()].filter(chat => !chat.running && chat.record.id !== this.active?.id && !this.chatLoads.has(chat.record.id));
    for (const chat of idle.slice(0, Math.max(0, idle.length - 2))) void this.guarded(() => this.unloadChat(chat.record.id));
  }

  private syncActiveView(): void {
    const chat = this.chat;
    this.sidebar.postMessage({ type: 'toolState', tools: [] });
    this.sidebar.postMessage({ type: 'diffState', diffs: chat ? this.diffItems(chat.review.list()) : [] });
  }

  private updateStatus(): void {
    const running = [...this.chats.values()].filter(chat => chat.running).length;
    const label = runtimeLabel(this.active?.provider || '');
    const pending = this.review?.pending().length || 0;
    this.status.text = running ? `$(sync~spin) ${running > 1 ? `${running} chats` : label} running` : pending ? `$(diff) ${label} ${pending} pending` : `$(hubot) ${label} ready`;
  }

  private postRun(chatId: string, state: 'idle' | 'thinking' | 'tool' | 'cancelling', label: string): void {
    this.sidebar.postMessage({ type: 'runState', sessionId: chatId, state, label });
  }

  public dispose(): void {
    if (this.timelineTimer) clearTimeout(this.timelineTimer);
    void this.context.workspaceState.update(TIMELINES_KEY, this.timelines);
    for (const chat of this.chats.values()) { chat.review.dispose(); chat.mirror.dispose(); }
    for (const disposable of this.disposables) disposable.dispose();
  }

  private registerCommands(): void {
    const command = (name: string, action: () => Promise<void> | void): void => {
      this.disposables.push(vscode.commands.registerCommand(name, () => this.guarded(action)));
    };
    command('dsh.newChat', () => this.newChat());
    command('dsh.continue', () => this.continueChat());
    command('dsh.cancel', () => this.cancel());
    command('dsh.pickModel', () => this.pickModel());
    command('dsh.manageModels', () => this.manageModels());
    command('dsh.manageAccounts', () => this.manageAccounts());
    command('dsh.applyAll', () => this.review?.applyAll());
    command('dsh.rejectAll', () => this.review?.rejectAll());
    command('dsh.openRuntimeLogs', () => { this.output.show(); });
    command('dsh.restartRuntime', () => this.restartRuntime());
    command('dsh.checkForUpdates', () => this.checkUpdates(true));
    command('dsh.reviewNext', () => this.reviewNext());
    command('dsh.reviewAll', () => this.review?.openAll());
    command('dsh.openWorkingCopyTerminal', () => this.openWorkingCopyTerminal());
    command('dsh.applyHunk', () => this.review?.chooseHunk('apply'));
    command('dsh.rejectHunk', () => this.review?.chooseHunk('reject'));
  }

  private async guarded(action: () => Promise<void> | void): Promise<void> {
    try { await action(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(message);
      this.sidebar.postMessage({ type: 'error', message });
    }
  }

  private root(): vscode.WorkspaceFolder {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file') throw new Error('Open a local workspace folder to use DSH.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace to run DSH tools.');
    return folder;
  }

  private sessions(): SessionRecord[] { return this.context.workspaceState.get<SessionRecord[]>(SESSIONS_KEY, []); }

  private async saveSession(record: SessionRecord, setActive = true): Promise<void> {
    if (this.deletedSessions.has(record.id)) return;
    await this.context.workspaceState.update(SESSIONS_KEY, [record, ...this.sessions().filter(item => item.id !== record.id)].slice(0, 100));
    if (setActive && this.active?.id === record.id) await this.context.workspaceState.update(ACTIVE_SESSION_KEY, record.id);
    this.refreshSessions();
  }

  private checkUpdates(manual = false): Promise<void> {
    return this.runUpdates(manual).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`DSH update failed: ${message}`);
      if (manual) void vscode.window.showErrorMessage(`DSH update failed: ${message}`);
    });
  }

  private requireCurrent(): void {
    if (!this.updateRequired) return;
    if (this.reloadPending) void this.promptReload();
    else void this.checkUpdates(true);
    throw new Error(this.updateRequired);
  }

  private async promptReload(): Promise<void> {
    const reload = await vscode.window.showInformationMessage('DSH-IDE was updated. Reload the window to use it.', { modal: true }, 'Reload Window');
    if (reload) await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  /** Overlapping checks share one lookup, but each caller applies its own manual flag. */
  private findUpdates(): Promise<UpdateOffer & { failures: string[] }> {
    return this.updateCheck ??= (async () => {
      const repository = vscode.workspace.getConfiguration('dsh').get<string>('updates.repository', '').trim();
      const storage = this.context.globalStorageUri.fsPath;
      const current = this.context.extension.packageJSON.version as string;
      const failures: string[] = [];
      const settled = async <T>(label: string, task: Promise<T>): Promise<T | undefined> => {
        try { return await task; }
        catch (error) {
          const message = `${label} update check failed: ${error instanceof Error ? error.message : String(error)}`;
          this.output.appendLine(message);
          failures.push(message);
          return undefined;
        }
      };
      const [extension, installed, latest] = await Promise.all([
        repository ? settled('DSH-IDE', latestExtensionRelease(repository, current)) : undefined,
        settled('DSH', currentVersion(storage)),
        settled('DSH', latestVersion()),
      ]);
      const dsh = installed && latest && compareVersions(latest, installed) > 0 ? { current: installed, latest } : undefined;
      return { extension, dsh, failures };
    })().finally(() => { this.updateCheck = undefined; });
  }

  // Prompts are never awaited while holding updateCheck or updateInstall: an ignored
  // notification would otherwise block every later check until the window reloads.
  private async runUpdates(manual: boolean): Promise<void> {
    if (this.updateInstall) {
      if (manual) void vscode.window.showInformationMessage('A DSH update is already installing.');
      return;
    }
    const config = vscode.workspace.getConfiguration('dsh');
    const current = this.context.extension.packageJSON.version as string;
    const { extension, dsh, failures } = await this.findUpdates();
    const plan = planUpdates({ extension, dsh }, {
      promptOptional: manual || config.get<boolean>('updates.check', true),
      skippedDsh: this.context.globalState.get<string>('dsh.ide.skippedDshVersion'),
    });
    if (!plan) {
      if (manual && failures.length) void vscode.window.showWarningMessage(`Could not finish checking for updates. ${failures.join(' ')}`);
      else if (manual) void vscode.window.showInformationMessage('DSH-IDE and DSH are up to date.');
      return;
    }
    const parts = [plan.extension && `DSH-IDE ${plan.extension.version}`, plan.dsh && `DSH ${plan.dsh.latest}`].filter(Boolean).join(' and ');
    if (plan.required) {
      this.updateRequired = `DSH ${plan.dsh!.latest} is available, so DSH-IDE ${plan.extension!.version} must be installed before you can keep using it. Run "DSH: Check for Updates" to continue.`;
      const choice = await vscode.window.showWarningMessage(`${parts} must be installed to keep using DSH-IDE.`,
        { modal: true, detail: `You have DSH-IDE ${current} and DSH ${plan.dsh!.current}. Chats are disabled until the update is installed.` }, 'Update now');
      if (!choice) return;
    } else {
      const buttons = plan.dsh && !plan.extension ? ['Update', 'Later', 'Skip this version'] : ['Update', 'Later'];
      const choice = await vscode.window.showInformationMessage(`${parts} ${plan.extension && plan.dsh ? 'are' : 'is'} available.`, ...buttons);
      if (choice === 'Skip this version') { await this.context.globalState.update('dsh.ide.skippedDshVersion', plan.dsh!.latest); return; }
      if (choice !== 'Update') return;
    }
    // Another prompt may have started the same install while this one was open.
    if (this.updateInstall) return;
    const install = this.installUpdates(plan, parts);
    this.updateInstall = install.finally(() => { this.updateInstall = undefined; }).catch(() => undefined);
    let dshError: unknown;
    try { ({ dshError } = await install); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`DSH update failed: ${message}`);
      void vscode.window.showErrorMessage(`DSH update failed: ${message}`);
      return;
    }
    if (dshError) {
      const message = dshError instanceof Error ? dshError.message : String(dshError);
      this.output.appendLine(`DSH update failed: ${message}`);
      void vscode.window.showErrorMessage(`DSH-IDE ${plan.extension!.version} installed, but DSH ${plan.dsh!.latest} failed: ${message} Reload, then run "DSH: Check for Updates" to retry.`);
    }
    if (plan.extension) {
      if (plan.required) await this.promptReload();
      else {
        this.updateRequired = undefined;
        const installed = dshError ? `DSH-IDE ${plan.extension.version}` : parts;
        const reload = await vscode.window.showInformationMessage(`${installed} installed. Reload the window to use the update.`, 'Reload Window', 'Later');
        if (reload) await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    } else {
      this.updateRequired = undefined;
      const restart = await vscode.window.showInformationMessage(`DSH ${plan.dsh!.latest} is installed. Restart the runtime to use it.`, 'Restart runtime');
      if (restart) await this.guarded(() => this.restartRuntime());
    }
  }

  /** The VSIX is small and is what unblocks a required update, so it installs before the much larger npm download. */
  private async installUpdates(plan: UpdatePlan, parts: string): Promise<{ dshError?: unknown }> {
    const storage = this.context.globalStorageUri.fsPath;
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Updating ${parts}…` }, async progress => {
      if (plan.extension) {
        progress.report({ message: `Downloading DSH-IDE ${plan.extension.version}` });
        await installExtensionRelease(plan.extension, path => vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(path)));
        if (plan.required) {
          this.reloadPending = true;
          this.updateRequired = 'DSH-IDE was updated. Reload the window to continue.';
        }
      }
      if (!plan.dsh) return {};
      const latest = plan.dsh.latest;
      try {
        progress.report({ message: `Downloading DSH ${latest}` });
        const node = await this.ensureNode();
        await installVersion(storage, latest, node, downloads => progress.report({ message: `Downloading DSH ${latest} (${downloads} files)` }));
        return {};
      } catch (error) {
        // Keep a finished extension install usable; the caller reports the DSH failure.
        if (plan.extension) return { dshError: error };
        throw error;
      }
    });
  }

  private async deleteSession(id: string): Promise<void> {
    const record = this.sessions().find(item => item.id === id);
    if (!record) return;
    if (this.chats.get(id)?.running) throw new Error('Cancel this chat before deleting it.');
    const wasActive = this.active?.id === id || (!this.active && this.context.workspaceState.get<string>(ACTIVE_SESSION_KEY) === id);
    this.deletedSessions.add(id);
    const unloaded = this.unloadChat(id);
    const remaining = this.sessions().filter(item => item.id !== id);
    const saved = this.context.workspaceState.update(SESSIONS_KEY, remaining);
    const selected = wasActive ? this.context.workspaceState.update(ACTIVE_SESSION_KEY, remaining[0]?.id) : Promise.resolve();
    if (wasActive) this.active = undefined;
    this.transcripts.delete(id);
    this.sidebar.postMessage({ type: 'sessionDeleted', sessionId: id });
    this.refreshSessions();
    if (wasActive && remaining.length) await this.continueChat(remaining[0].id);
    else if (wasActive) { this.syncActiveView(); this.updateStatus(); }
    await Promise.all([saved, selected, unloaded]);
    await this.saveTranscripts();
    // An in-flight creation must finish disposing its watcher before its files
    // are removed; otherwise copying and recursive deletion can race.
    await this.chatLoads.get(id)?.catch(() => undefined);
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder?.uri.scheme === 'file') await WorkspaceMirror.remove(folder.uri, this.context.globalStorageUri.fsPath, record.mirrorId).catch(error => this.output.appendLine(`Could not remove chat files: ${String(error)}`));
  }

  private refreshSessions(): void {
    this.sidebar.postMessage({
      type: 'sessionState',
      sessions: this.sessions().map(item => ({ id: item.id, name: item.name, updatedAt: item.updatedAt })),
      activeSessionId: this.active?.id || this.context.workspaceState.get<string>(ACTIVE_SESSION_KEY),
    });
  }

  private refreshModels(): void {
    const current = this.availableModel(this.selectedModel);
    const choice = this.choiceFor(current);
    this.sidebar.postMessage({
      type: 'modelState',
      models: this.availableModels().map(model => ({ id: model.name, name: model.name, provider: model.provider,
        backend: model.backend, account: model.account, enabled: model.enabled,
        speedOptions: model.speedOptions, effortOptions: model.effortOptions })),
      cursorBackends: this.cursorModels.map(model => ({ value: model.backend, name: model.name.replace(/^Cursor /, '') })),
      selectedModelId: this.selectedModel, selectedSpeed: choice.speed, selectedEffort: choice.effort,
    });
  }

  private choiceFor(model?: ModelEntry): ModelChoice {
    if (!model) return {};
    const stored = this.modelChoices[model.name] || {};
    return {
      speed: model.speedOptions?.some(item => item.label === stored.speed) ? stored.speed : model.speedOptions?.[0]?.label,
      effort: model.effortOptions?.includes(stored.effort || '') ? stored.effort : '',
    };
  }

  private effectiveModel(model: ModelEntry): ModelEntry {
    const choice = this.choiceFor(model);
    const backend = model.speedOptions?.find(item => item.label === choice.speed)?.backend || model.backend;
    return { ...model, backend };
  }

  private async refreshAccounts(checkCursor = true): Promise<void> {
    if (checkCursor && !this.cursorAccount.busy) {
      try {
        const output = await this.runCursorCommand('status', undefined, 15000);
        const connected = !/not authenticated|not logged in|unauthenticated/i.test(output) && /authenticated|logged in/i.test(output);
        const email = output.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/i)?.[0];
        this.cursorAccount = { connected, label: connected ? email || 'Cursor account' : 'Not connected' };
      } catch { this.cursorAccount = { connected: false, label: 'Cursor CLI unavailable' }; }
    }
    this.sidebar.postMessage({ type: 'accountsState', accounts: [
      ...this.oauthAccounts.list().map(account => ({ id: account.id, provider: account.provider, label: account.label,
        email: account.email, isDefault: this.oauthAccounts.getDefault(account.provider)?.id === account.id, authType: 'oauth' as const })),
      ...this.accounts.list().map(account => ({ id: account.id, provider: account.provider, label: account.label, email: account.email,
        isDefault: this.accounts.getDefault(account.provider)?.id === account.id, authType: 'api-key' as const })),
    ], cursor: this.cursorAccount });
    await this.refreshAccount();
  }

  private availableModels(): ModelEntry[] {
    return this.models.list();
  }

  private availableModel(name: string): ModelEntry | undefined {
    return this.availableModels().find(model => model.name === name);
  }

  private async refreshCursorModels(runtime: AcpRuntime, sessionId: string): Promise<void> {
    const options = runtime.models(sessionId);
    if (!options.length) return;
    this.cursorModels = options.filter(option => option.value !== 'auto').map(option => ({
      name: `Cursor ${option.name}`, provider: 'cursor-acp', backend: option.value,
      account: 'cursor-login', enabled: true,
    }));
    await this.context.workspaceState.update(CURSOR_MODELS_KEY, this.cursorModels);
    this.refreshModels();
  }

  private async refreshAccount(): Promise<void> {
    const model = this.availableModel(this.selectedModel);
    if (!model) return;
    if (model.provider === 'cursor-acp') {
      this.sidebar.postMessage({ type: 'accountState', provider: 'Cursor', label: this.cursorAccount.connected ? this.cursorAccount.label : 'Connect Cursor account', connected: this.cursorAccount.connected });
      this.status.tooltip = `${model.name} · ${this.cursorAccount.label}`;
      return;
    }
    if (isOAuthProvider(model.provider)) {
      const account = model.account && model.account !== 'default' ? this.oauthAccounts.get(model.account) : this.oauthAccounts.getDefault(model.provider);
      this.sidebar.postMessage({ type: 'accountState', provider: model.provider, label: account?.label || 'Connect an account', connected: !!account });
      this.status.tooltip = `${model.name} · ${account?.label || 'no account'}`;
      return;
    }
    const account = model.account && model.account !== 'default' ? this.accounts.get(model.account) : this.accounts.getDefault(model.provider);
    this.sidebar.postMessage({ type: 'accountState', provider: model.provider, label: account?.label || 'Add an account', connected: !!account });
    this.status.tooltip = `${model.name} · ${model.provider} · ${account?.label || 'no account'}`;
  }

  private async resolveRoute(override?: ModelEntry): Promise<ResolvedRoute> {
    await this.ensureNode();
    await this.refreshDependencies();
    const selected = override ?? this.availableModel(this.selectedModel);
    if (!selected) throw new Error('Pick a model first.');
    const model = override ?? this.effectiveModel(selected);
    if (model.provider === 'cursor-acp') return { model };
    if (isOAuthProvider(model.provider)) {
      const oauthAccount = model.account && model.account !== 'default' ? this.oauthAccounts.get(model.account) : this.oauthAccounts.getDefault(model.provider);
      if (!oauthAccount) {
        this.sidebar.postMessage({ type: 'showPage', page: 'accounts' });
        throw new Error(`Connect a ${model.provider === 'codex-cli' ? 'ChatGPT' : 'Claude'} account in Accounts first.`);
      }
      return { model, oauthAccount };
    }
    if (!this.accounts.getDefault(model.provider) && (!model.account || model.account === 'default')) {
      this.sidebar.postMessage({ type: 'showPage', page: 'accounts' });
      throw new Error(`Add a ${model.provider} API key account in Accounts before starting a chat.`);
    }
    const route = await this.models.resolve(model.name);
    await this.refreshAccount();
    return { ...route, model };
  }

  private envName(provider: string): string {
    const configured: Record<string, string> = {
      'deepseek-official': 'DEEPSEEK_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      openrouter: 'OPENROUTER_API_KEY',
    };
    const name = configured[provider];
    if (!name) throw new Error(`Provider '${provider}' needs an explicit DSH adapter and credential mapping before it can run.`);
    return name;
  }

  private cursorAgentLaunch(): { command: string; args: string[] } {
    const configured = vscode.workspace.getConfiguration('dsh').get<string>('runtime.cursorAgentPath')?.trim() || 'agent';
    if (process.platform === 'win32') {
      const root = configured === 'agent' ? join(process.env.LOCALAPPDATA || '', 'cursor-agent')
        : configured.toLowerCase().endsWith('.cmd') || configured.toLowerCase().endsWith('.ps1') ? dirname(configured) : configured;
      const versions = join(root, 'versions');
      if (existsSync(versions)) {
        const latest = readdirSync(versions, { withFileTypes: true }).filter(entry => entry.isDirectory())
          .map(entry => entry.name).sort().reverse().find(version =>
            existsSync(join(versions, version, 'node.exe')) && existsSync(join(versions, version, 'index.js')));
        if (latest) {
          const versionPath = join(versions, latest);
          return {
            command: join(versionPath, 'node.exe'), args: [join(versionPath, 'index.js'), 'acp'],
          };
        }
      }
    }
    return { command: configured, args: ['acp'] };
  }

  private runCursorCommand(subcommand: 'status' | 'login' | 'logout', onOutput?: (text: string) => void, timeoutMs = 30000): Promise<string> {
    const launch = this.cursorAgentLaunch();
    return new Promise<string>((resolve, reject) => {
      let output = '';
      let settled = false;
      const child = spawn(launch.command, [...launch.args.slice(0, -1), subcommand], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(subcommand === 'login' ? { NO_OPEN_BROWSER: '1' } : {}) },
      });
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(output);
      };
      const timer = setTimeout(() => { child.kill(); finish(new Error(`Cursor ${subcommand} timed out.`)); }, timeoutMs);
      const read = (chunk: Buffer): void => {
        const text = chunk.toString('utf8');
        output = (output + text).slice(-65536);
        onOutput?.(output);
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.on('error', () => finish(new Error('Cursor Agent CLI could not start. Check dsh.runtime.cursorAgentPath.')));
      child.on('close', code => finish(code === 0 ? undefined : new Error(`Cursor ${subcommand} failed. Open Accounts and try again.`)));
    });
  }

  private async cursorLogin(): Promise<void> {
    if (this.cursorAccount.busy) return;
    this.cursorAccount = { ...this.cursorAccount, busy: true, error: undefined, authUrl: undefined };
    await this.refreshAccounts(false);
    let opened = false;
    try {
      await this.runCursorCommand('login', output => {
        if (opened) return;
        const match = output.match(/https:\/\/[^\s\x1b]+/i);
        if (!match) return;
        const url = match[0].replace(/[).,;]+$/, '');
        if (!this.safeCursorAuthUrl(url)) return;
        opened = true;
        this.cursorAccount = { ...this.cursorAccount, authUrl: url };
        void this.refreshAccounts(false);
        void vscode.env.openExternal(vscode.Uri.parse(url));
      }, 300000);
      this.cursorAccount = { ...this.cursorAccount, busy: false };
      await this.refreshAccounts();
      await this.refreshAccount();
    } catch (error) {
      this.cursorAccount = { ...this.cursorAccount, busy: false, error: error instanceof Error ? error.message : String(error) };
      await this.refreshAccounts(false);
      throw error;
    }
  }

  private safeCursorAuthUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && (url.hostname === 'cursor.com' || url.hostname.endsWith('.cursor.com') || url.hostname === 'cursor.sh' || url.hostname.endsWith('.cursor.sh'));
    } catch { return false; }
  }

  private async cursorLogout(): Promise<void> {
    const cursorChats = [...this.chats.values()].filter(chat => chat.record.provider === 'cursor-acp');
    if (cursorChats.length) {
      if (cursorChats.some(chat => chat.running)) throw new Error('Wait for running Cursor chats before disconnecting.');
      if (cursorChats.some(chat => chat.review.pending().length)) throw new Error('Apply or reject pending edits before disconnecting Cursor.');
      const wasActive = cursorChats.some(chat => chat.record.id === this.active?.id);
      for (const chat of cursorChats) await this.unloadChat(chat.record.id);
      if (wasActive) await this.context.workspaceState.update(ACTIVE_SESSION_KEY, undefined);
      this.refreshSessions();
      this.syncActiveView();
    }
    await this.runCursorCommand('logout');
    this.cursorAccount = { connected: false, label: 'Not connected' };
    await this.refreshAccounts();
    await this.refreshAccount();
  }

  private async ensureRuntime(route: ResolvedRoute, cwd: string, ownerId: string): Promise<{ runtime: AcpRuntime; key: string } | undefined> {
    await this.ensureNode();
    if ('oauthAccount' in route) await this.refreshDependencies();
    if ('oauthAccount' in route) return undefined;
    if (route.model.provider === 'cursor-acp') {
      const key = `cursor-acp:${ownerId}`;
      const runtime = this.runtimeFor(key);
      const { command, args } = this.cursorAgentLaunch();
      try { await runtime.start({ kind: 'cursor', command, args, cwd }); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not start Cursor Agent CLI. Install it from https://cursor.com/docs/cli/installation, run "agent login", or set dsh.runtime.cursorAgentPath. ${message}`);
      }
      await this.refreshAccount();
      return { runtime, key };
    }
    if (!('account' in route)) throw new Error('The selected API provider has no account.');
    const deepSeekAccount = this.accounts.getDefault('deepseek-official');
    // A forced cancellation must not terminate another chat or subagent.
    const key = `${route.model.provider}:${route.account.id}:${route.model.backend}:${deepSeekAccount?.id || ''}:${ownerId}`;
    const runtime = this.runtimeFor(key);
    const accountHash = createHash('sha256').update(route.account.id).digest('hex').slice(0, 16);
    const providerHash = createHash('sha256').update(route.model.provider).digest('hex').slice(0, 16);
    const home = join(this.context.globalStorageUri.fsPath, 'runtime', providerHash, accountHash);
    const nodePath = await this.ensureNode();
    const webSearchKey = deepSeekAccount ? await this.accounts.getSecret(deepSeekAccount.id) : undefined;
    await runtime.start({ kind: 'dsh', provider: route.model.provider, model: route.model.backend, apiKey: route.secret,
      webSearchKey, envName: this.envName(route.model.provider), home, nodePath, dshRoot: await updatedRoot(this.context.globalStorageUri.fsPath) });
    return { runtime, key };
  }

  private readonly pendingApprovals = new Map<string, { sessionId: string; resolve: (allow: boolean) => void }>();

  private askInChat(sessionId: string | undefined, title: string, detail: string): Promise<boolean> {
    if (!sessionId) return Promise.resolve(false);
    const id = randomUUID();
    void vscode.commands.executeCommand('workbench.view.extension.dsh');
    return new Promise<boolean>(resolve => {
      this.pendingApprovals.set(id, { sessionId, resolve });
      this.sidebar.postMessage({ type: 'approvalRequest', sessionId, id, title, detail: detail.slice(0, 2000) });
    });
  }

  private settleChatApprovals(chatId: string): void {
    for (const [id, pending] of [...this.pendingApprovals]) if (pending.sessionId === chatId) this.settleApproval(id, false);
    for (const [id, pending] of [...this.pendingQuestions]) if (pending.sessionId === chatId) this.settleQuestion(id, null);
  }

  private readonly pendingQuestions = new Map<string, { sessionId: string; resolve: (answers: string[] | null) => void }>();

  private askQuestions(chat: Chat, args: Record<string, unknown>): Promise<DelegateResult> {
    if (chat.cancelRequested) return Promise.resolve({ text: 'Cancelled.', isError: true });
    const parsed = parseQuestions(args);
    if ('error' in parsed) return Promise.resolve({ text: parsed.error, isError: true });
    const id = randomUUID();
    const sessionId = chat.record.id;
    void vscode.commands.executeCommand('workbench.view.extension.dsh');
    return new Promise<DelegateResult>(resolve => {
      this.pendingQuestions.set(id, { sessionId, resolve: answers => resolve({ text: formatAnswers(parsed.questions, answers) }) });
      this.sidebar.postMessage({ type: 'questionRequest', sessionId, id, questions: parsed.questions });
    });
  }

  private settleQuestion(id: string, answers: string[] | null): void {
    const pending = this.pendingQuestions.get(id);
    if (!pending) return;
    this.pendingQuestions.delete(id);
    this.sidebar.postMessage({ type: 'questionResolved', sessionId: pending.sessionId, id, answers });
    pending.resolve(answers);
  }

  private toolpackTools(): DelegateToolInfo[] { return this.toolpacks.descriptors(); }

  private postToolpacks(error?: string): void {
    this.sidebar.postMessage({ type: 'toolpacksState', packs: this.toolpacks.list(), error });
  }

  private async addToolpack(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFolders: false, filters: { TypeScript: ['ts'] }, openLabel: 'Upload toolpack' });
    if (!picked?.[0]) return;
    try {
      await this.toolpacks.add(picked[0].fsPath);
      this.postToolpacks();
    } catch (error) {
      this.postToolpacks(`Could not add ${basename(picked[0].fsPath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private settleApproval(id: string, allow: boolean): void {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return;
    this.pendingApprovals.delete(id);
    this.sidebar.postMessage({ type: 'approvalResolved', sessionId: pending.sessionId, id, allowed: allow });
    pending.resolve(allow);
  }

  private rid(record: SessionRecord): string { return record.runtimeId || record.id; }

  private async switchModel(chat: Chat, override?: ModelEntry): Promise<void> {
    const record = chat.record;
    const route = await this.resolveRoute(override);
    const model = route.model;
    const effort = override ? record.effort : this.choiceFor(this.availableModel(model.name)).effort;
    const accountId = 'oauthAccount' in route ? route.oauthAccount.id : 'account' in route ? route.account.id : 'cursor-login';
    const cwd = chat.mirror.cwd;
    const oauth = isOAuthProvider(model.provider);
    const sameBackendSession = record.provider === model.provider && (oauth || model.provider === 'cursor-acp') && record.accountId === accountId;
    const slot = await this.ensureRuntime(route, cwd, chat.ownerId);
    const previous = { runtime: chat.runtime, key: chat.runtimeKey };
    if (oauth || !slot) {
      if (!sameBackendSession) { record.cliSessionId = undefined; chat.handoffPending = true; }
      chat.runtime = undefined; chat.runtimeKey = undefined;
    } else {
      const reuse = previous.runtime === slot.runtime && previous.key === slot.key && record.provider === model.provider && model.provider === 'cursor-acp';
      if (!reuse) {
        if (previous.runtime) await previous.runtime.closeSession(this.rid(record)).catch(() => undefined);
        record.runtimeId = await slot.runtime.newSession(cwd, this.mcpServers(chat.ownerId));
        chat.handoffPending = true;
      }
      chat.runtime = slot.runtime; chat.runtimeKey = slot.key;
      const id = this.rid(record);
      if (model.provider === 'cursor-acp') {
        await this.refreshCursorModels(slot.runtime, id);
        if (model.backend !== 'auto' || slot.runtime.models(id).some(option => option.value === 'auto')) await slot.runtime.setModel(id, model.backend);
      }
      if (effort) await slot.runtime.setConfigOption(id, 'reasoning_effort', effort);
    }
    if (previous.key !== chat.runtimeKey) await this.releaseRuntime(previous.key);
    Object.assign(record, { modelName: model.name, provider: model.provider, backend: model.backend, effort, accountId });
    record.updatedAt = Date.now();
    await this.saveSession(record);
    this.refreshSessions();
  }

  private async newChat(): Promise<void> {
    this.root();
    const selected = this.availableModel(this.selectedModel);
    if (!selected) throw new Error('Pick a model first.');
    const model = this.effectiveModel(selected);
    const account = isOAuthProvider(model.provider)
      ? model.account && model.account !== 'default' ? this.oauthAccounts.get(model.account) : this.oauthAccounts.getDefault(model.provider)
      : model.account && model.account !== 'default' ? this.accounts.get(model.account) : this.accounts.getDefault(model.provider);
    if (model.provider !== 'cursor-acp' && !account) throw new Error('Connect an account in Accounts before starting a chat.');
    // Creating a chat is a local navigation operation. Copy files and start the
    // provider only when the chat is used, rather than blocking the New button.
    const record: SessionRecord = {
      id: randomUUID(), mirrorId: randomUUID(), pendingMirror: true, name: 'New chat',
      // Fixed per chat: the provider session is tied to its working directory.
      direct: vscode.workspace.getConfiguration('dsh').get<boolean>('runtime.mirror', true) ? undefined : true,
      modelName: model.name, provider: model.provider, backend: model.backend,
      effort: this.choiceFor(selected).effort, accountId: account?.id || 'cursor-login', updatedAt: Date.now(),
    };
    this.active = record;
    const saved = this.saveSession(record);
    this.refreshSessions(); this.syncActiveView();
    this.postRun(record.id, 'idle', 'Ready'); this.updateStatus();
    this.trimChats();
    await saved;
  }

  private addChat(record: SessionRecord, mirror: WorkspaceMirror, review: ReviewController, ownerId: string, slot?: { runtime: AcpRuntime; key: string }): Chat {
    const chat: Chat = {
      record, mirror, review, cli: new OAuthCliRuntime(), running: false, cancelRequested: false, queue: [], turnEntryId: '',
      segment: 0, startedTools: new Set(), subagentIds: new Set(), delegationToolIds: new Set(), subagentText: new Map(), turnReply: '', handoffPending: false,
      ownerId, runtime: slot?.runtime, runtimeKey: slot?.key, locks: new Map(), children: new Set(),
    };
    this.chats.set(record.id, chat);
    return chat;
  }

  /** Direct-mode chats treat files the user saves during a turn as the user's edits. */
  private adoptSave(document: vscode.TextDocument): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (document.uri.scheme !== 'file' || !folder) return;
    const path = relative(folder.uri.fsPath, document.uri.fsPath);
    if (!path || path.startsWith('..') || isAbsolute(path)) return;
    for (const chat of this.chats.values()) void chat.mirror.adopt(path, document.getText()).catch(() => undefined);
  }

  private createReview(root: vscode.Uri, mirror: WorkspaceMirror, chatId: string): ReviewController {
    const review = new ReviewController(root, (path, text) => mirror.acknowledge(path, text), 'dsh-review', (path, text) => mirror.restore(path, text), mirror.direct);
    this.disposables.push(review.onProposalsChanged(items => this.onProposalsChanged(chatId, items)));
    return review;
  }

  private async continueChat(id?: string): Promise<void> {
    this.root();
    const record = this.sessions().find(item => item.id === (id || this.context.workspaceState.get<string>(ACTIVE_SESSION_KEY))) || this.sessions()[0];
    if (!record) { await this.newChat(); return; }
    if (this.active?.id === record.id) return;
    this.active = this.chats.get(record.id)?.record || record;
    const warm = this.chat;
    if (warm) { this.chats.delete(record.id); this.chats.set(record.id, warm); }
    await this.afterActivate(this.active, !this.chat?.running);
    this.trimChats();
    // Restore pending review edits after painting the saved conversation. Warm
    // chats keep their mirror and backend, so repeated switches are immediate.
    if (!record.pendingMirror && !this.chats.has(record.id)) {
      try { await this.loadChat(record); }
      catch (error) { if (this.deletedSessions.has(record.id)) return; throw error; }
      if (this.active?.id === record.id) { this.syncActiveView(); this.updateStatus(); }
    }
  }

  private loadChat(record: SessionRecord): Promise<Chat> {
    if (this.deletedSessions.has(record.id)) return Promise.reject(new Error('This chat was deleted.'));
    const existing = this.chats.get(record.id);
    if (existing) return Promise.resolve(existing);
    const pending = this.chatLoads.get(record.id);
    if (pending) return pending;
    const load = this.prepareChat(record).finally(() => this.chatLoads.delete(record.id));
    this.chatLoads.set(record.id, load);
    return load;
  }

  private async prepareChat(record: SessionRecord): Promise<Chat> {
    const root = this.root();
    let route: ResolvedRoute;
    if (record.provider === 'cursor-acp') {
      route = { model: { name: record.modelName, provider: record.provider, backend: record.backend, account: 'cursor-login', enabled: true } };
    } else if (isOAuthProvider(record.provider)) {
      const oauthAccount = this.oauthAccounts.get(record.accountId);
      if (!oauthAccount) throw new Error(`Account for '${record.name}' is missing. Connect it again to continue.`);
      route = { model: { name: record.modelName, provider: record.provider, backend: record.backend, account: oauthAccount.id, enabled: true }, oauthAccount };
    } else {
      const account = this.accounts.get(record.accountId);
      const secret = account && await this.accounts.getSecret(account.id);
      if (!account || !secret) throw new Error(`Account for '${record.name}' is missing. Add it again to continue.`);
      const model: ModelEntry = { name: record.modelName, provider: record.provider, backend: record.backend, account: account.id, enabled: true };
      route = { model, account, secret };
    }
    if (this.deletedSessions.has(record.id)) throw new Error('This chat was deleted.');
    const holder: { review?: ReviewController; changes?: MirrorChange[] } = {};
    const onChanges = (changes: MirrorChange[]): void => {
      if (holder.review) holder.review.update(changes);
      else holder.changes = changes;
    };
    const fresh = !!record.pendingMirror;
    const mirror = fresh
      ? await WorkspaceMirror.create(root.uri, this.context.globalStorageUri.fsPath, onChanges, record.mirrorId, !!record.direct)
      : await WorkspaceMirror.reopen(root.uri, this.context.globalStorageUri.fsPath, record.mirrorId, onChanges, !!record.direct);
    holder.review = this.createReview(root.uri, mirror, record.id);
    if (holder.changes) holder.review.update(holder.changes);
    const ownerId = randomUUID();
    let slot: { runtime: AcpRuntime; key: string } | undefined;
    try {
      if (this.deletedSessions.has(record.id)) throw new Error('This chat was deleted.');
      slot = await this.ensureRuntime(route, mirror.cwd, ownerId);
      const runtimeId = fresh && slot ? await slot.runtime.newSession(mirror.cwd, this.mcpServers(ownerId)) : this.rid(record);
      if (slot && !fresh) await slot.runtime.resumeSession(runtimeId, mirror.cwd, this.mcpServers(ownerId));
      if (fresh) record.runtimeId = slot ? runtimeId : undefined;
      if (slot && record.provider === 'cursor-acp') {
        await this.refreshCursorModels(slot.runtime, runtimeId);
        if (record.backend !== 'auto' || slot.runtime.models(runtimeId).some(option => option.value === 'auto')) {
          await slot.runtime.setModel(runtimeId, record.backend);
        }
      }
      if (slot && record.effort) await slot.runtime.setConfigOption(runtimeId, 'reasoning_effort', record.effort);
    } catch (error) {
      holder.review.dispose(); mirror.dispose();
      if (slot) await this.releaseRuntime(slot.key);
      if (fresh) await WorkspaceMirror.remove(root.uri, this.context.globalStorageUri.fsPath, mirror.id).catch(() => undefined);
      throw error;
    }
    if (this.deletedSessions.has(record.id)) {
      holder.review.dispose(); mirror.dispose();
      if (slot) { await slot.runtime.closeSession(this.rid(record)).catch(() => undefined); await this.releaseRuntime(slot.key); }
      await WorkspaceMirror.remove(root.uri, this.context.globalStorageUri.fsPath, mirror.id);
      throw new Error('This chat was deleted.');
    }
    if (fresh) { record.mirrorId = mirror.id; record.pendingMirror = undefined; }
    const chat = this.addChat(record, mirror, holder.review, ownerId, slot);
    await this.saveSession(record, false);
    this.trimChats();
    return chat;
  }

  private async saveTranscripts(): Promise<void> {
    const keep = new Set(this.sessions().map(item => item.id));
    const data: Record<string, { role: 'user' | 'assistant'; text: string }[]> = {};
    for (const [id, items] of this.transcripts) if (keep.has(id)) data[id] = items;
    await this.context.workspaceState.update(TRANSCRIPTS_KEY, data);
    for (const id of Object.keys(this.timelines)) if (!keep.has(id)) delete this.timelines[id];
    await this.context.workspaceState.update(TIMELINES_KEY, this.timelines);
  }

  private replayTranscript(id: string): void {
    if (this.sidebar.hasTimeline(id)) return;
    const saved = this.timelines[id];
    if (saved) {
      for (const entry of saved.timeline) {
        if (entry.kind === 'tool' && entry.event.state === 'running') entry.event.state = 'cancelled';
        if (entry.kind === 'approval' && entry.status === 'pending') entry.status = 'rejected';
      }
      for (const agent of Object.values(saved.subagents)) if (agent.state === 'running') agent.state = 'cancelled';
      this.sidebar.postMessage({ type: 'timelineState', sessionId: id, ...saved });
      return;
    }
    (this.transcripts.get(id) || []).forEach((item, index) => {
      if (item.role === 'user') this.sidebar.postMessage({ type: 'userMessage', sessionId: id, entryId: `history:${index}`, text: item.text });
      else this.sidebar.postMessage({ type: 'assistantDelta', sessionId: id, entryId: `history:${index}`, text: item.text });
    });
  }

  private async editMessage(sessionId: string, entryId: string, text: string): Promise<void> {
    const chat = this.chats.get(sessionId);
    if (!chat || this.active?.id !== sessionId || chat.running) throw new Error('Wait for this chat to finish before editing a message.');
    if (!text.trim()) throw new Error('A message cannot be empty.');
    const timeline = this.sidebar.timeline(sessionId);
    const index = timeline.findIndex(entry => entry.id === entryId && entry.kind === 'message' && entry.role === 'user');
    if (index < 0) throw new Error('This message is no longer available.');
    // ACP has no rewind method. A new backend session prevents discarded turns,
    // including their tool results and compacted summaries, from leaking back in.
    if (chat.runtime) {
      const oldId = this.rid(chat.record);
      const newId = await chat.runtime.newSession(chat.mirror.cwd, this.mcpServers(chat.ownerId));
      chat.record.runtimeId = newId;
      await chat.runtime.closeSession(oldId).catch(() => undefined);
      if (chat.record.provider === 'cursor-acp') {
        await this.refreshCursorModels(chat.runtime, newId);
        if (chat.record.backend !== 'auto' || chat.runtime.models(newId).some(option => option.value === 'auto')) await chat.runtime.setModel(newId, chat.record.backend);
      }
      if (chat.record.effort) await chat.runtime.setConfigOption(newId, 'reasoning_effort', chat.record.effort);
    }
    chat.record.cliSessionId = undefined;
    chat.handoffPending = true;
    const retained = timeline.slice(0, index);
    const userIndex = timeline.slice(0, index).filter(entry => entry.kind === 'message' && entry.role === 'user').length;
    const history = this.transcripts.get(sessionId) || [];
    let users = 0;
    const cut = history.findIndex(item => item.role === 'user' && users++ === userIndex);
    this.transcripts.set(sessionId, cut >= 0 ? history.slice(0, cut) : retained.flatMap(entry => entry.kind === 'message' ? [{ role: entry.role, text: entry.text }] : []));
    const agents = this.sidebar.subagents(sessionId);
    const retainedAgents = Object.fromEntries(retained.flatMap(entry => entry.kind === 'subagent' && agents[entry.agentId] ? [[entry.agentId, agents[entry.agentId]]] : []));
    this.sidebar.postMessage({ type: 'timelineState', sessionId, timeline: retained, subagents: retainedAgents });
    await this.saveSession(chat.record);
    await this.saveTranscripts();
    await this.sendPrompt(text);
  }

  private instructionRoots(): InstructionRoots {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return {
      workspace: folder?.uri.scheme === 'file' ? folder.uri.fsPath : undefined,
      dshHome: process.env.DSH_HOME || join(homedir(), '.dsh'),
      agentsHome: process.env.DSH_AGENTS_HOME || join(homedir(), '.agents'),
    };
  }

  private async refreshInstructions(): Promise<void> {
    this.sidebar.postMessage({ type: 'instructionsState', items: await listInstructions(this.instructionRoots()) });
  }

  /** Keeps the active chat's private copy in step so the agent sees the change without it showing up as an edit to review. */
  private async syncInstructionMirror(item: InstructionItem, file: string, text?: string): Promise<void> {
    const workspace = this.instructionRoots().workspace;
    if (item.scope === 'workspace' && workspace && this.chat) await this.chat.mirror.restore(relative(workspace, file), text);
  }

  private async saveInstructionRequest(message: Extract<SidebarWebviewMessage, { type: 'saveInstruction' }>): Promise<void> {
    const saved = await saveInstruction(this.instructionRoots(), {
      id: message.id, kind: message.kind, scope: message.scope, file: message.file, name: message.name, description: message.description, content: message.content,
    });
    await this.syncInstructionMirror(saved.item, saved.file, await readFile(saved.file, 'utf8'));
    await this.refreshInstructions();
    this.sidebar.postMessage({ type: 'instructionSaved' });
  }

  private async removeInstructionRequest(id: string): Promise<void> {
    const removed = await removeInstruction(this.instructionRoots(), id);
    await this.syncInstructionMirror(removed.item, removed.file, undefined);
    await this.refreshInstructions();
  }

  private async afterActivate(record: SessionRecord, idle: boolean): Promise<void> {
    this.replayTranscript(record.id);
    this.selectedModel = record.modelName;
    const selected = this.availableModel(record.modelName);
    if (selected) {
      this.modelChoices[selected.name] = {
        speed: selected.speedOptions?.find(item => item.backend === record.backend)?.label,
        effort: record.effort || '',
      };
      void this.guarded(async () => { await this.context.workspaceState.update(MODEL_CHOICES_KEY, this.modelChoices); });
    }
    const saved = Promise.all([
      this.context.workspaceState.update(SELECTED_MODEL_KEY, this.selectedModel),
      this.context.workspaceState.update(ACTIVE_SESSION_KEY, record.id),
    ]);
    this.refreshSessions(); this.refreshModels();
    this.syncActiveView();
    if (idle) this.postRun(record.id, 'idle', 'Ready');
    this.updateStatus();
    void this.guarded(() => this.refreshAccount());
    await saved;
  }

  private async saveImages(images: SidebarImage[] | undefined): Promise<{ name: string; mimeType: string; data: string; path: string }[]> {
    if (!images?.length) return [];
    if (!Array.isArray(images) || images.length > MAX_IMAGES) throw new Error(`Attach up to ${MAX_IMAGES} files.`);
    const dir = join(this.context.globalStorageUri.fsPath, 'attachments');
    await mkdir(dir, { recursive: true });
    const saved: { name: string; mimeType: string; data: string; path: string }[] = [];
    let totalBytes = 0;
    for (const image of images) {
      const extension = IMAGE_TYPES[image?.mimeType] || String(image?.name || '').match(/\.([a-zA-Z0-9]{1,12})$/)?.[1] || 'bin';
      if (typeof image?.data !== 'string' || image.data.length > MAX_IMAGE_BASE64 || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
        throw new Error('Invalid attachment data. Files must be under 10 MB.');
      }
      const bytes = Buffer.from(image.data, 'base64');
      if (bytes.toString('base64') !== image.data) throw new Error('Invalid attachment data.');
      totalBytes += bytes.length;
      if (bytes.length > 10 * 1024 * 1024 || totalBytes > 20 * 1024 * 1024) throw new Error('Files must be under 10 MB each and 20 MB in total.');
      const path = join(dir, `${randomUUID()}.${extension}`);
      await writeFile(path, bytes);
      saved.push({ name: String(image.name || 'file').slice(0, 200), mimeType: image.mimeType || 'application/octet-stream', data: image.data, path });
    }
    return saved;
  }

  private postQueue(chat: Chat): void {
    this.sidebar.postMessage({ type: 'queueState', sessionId: chat.record.id, items: chat.queue.map(item => item.prompt || '(attachment)') });
  }

  private async sendPrompt(prompt: string, images?: SidebarImage[], queued?: { path: string; mimeType: string; data: string; name: string }[], queuedChatId?: string, mode: 'interrupt' | 'queue' = 'interrupt'): Promise<void> {
    if (!prompt.trim() && !images?.length && !queued?.length) return;
    this.requireCurrent();
    let created: Promise<void> | undefined;
    if (!queuedChatId && !this.active) {
      created = this.newChat();
      // newChat publishes its local record synchronously, before persistence.
      if (!this.active) await created;
    }
    const recordToLoad = queuedChatId ? this.sessions().find(item => item.id === queuedChatId) : this.active;
    if (!recordToLoad || this.deletedSessions.has(recordToLoad.id)) return;
    // Reserve startup so rapid sends cannot race model/attachment setup. Release
    // as soon as the turn starts; later sends retain queue/interrupt semantics.
    while (this.promptStarts.has(recordToLoad.id)) await this.promptStarts.get(recordToLoad.id);
    if (this.deletedSessions.has(recordToLoad.id)) return;
    let release!: () => void;
    const starting = new Promise<void>(resolve => { release = resolve; });
    this.promptStarts.set(recordToLoad.id, starting);
    const started = (): void => {
      if (this.promptStarts.get(recordToLoad.id) === starting) this.promptStarts.delete(recordToLoad.id);
      release();
    };
    try {
      await this.startPrompt(recordToLoad, prompt, images, queued, !!queuedChatId, mode, started, created);
    } finally { started(); }
  }

  private async startPrompt(recordToLoad: SessionRecord, prompt: string, images: SidebarImage[] | undefined,
    queued: { path: string; mimeType: string; data: string; name: string }[] | undefined,
    fromQueue: boolean, mode: 'interrupt' | 'queue', started: () => void, created?: Promise<void>): Promise<void> {
    const files = queued || images;
    const shown = [prompt.trim(), files?.length ? `[Files: ${files.map(file => String(file?.name || 'file').slice(0, 200)).join(', ')}]` : ''].filter(Boolean).join('\n\n');
    const turnEntryId = randomUUID();
    let displayed = false;
    const display = (): void => {
      this.replayTranscript(recordToLoad.id);
      this.sidebar.postMessage({ type: 'userMessage', sessionId: recordToLoad.id, entryId: `user:${turnEntryId}`, text: shown });
      displayed = true;
    };
    // Show accepted idle-chat messages before any file I/O or cold backend load.
    // Running-chat submissions remain in the queue until their turn begins.
    if (!this.chats.get(recordToLoad.id)?.running) display();
    if (created) await created;
    const attachments = queued ?? await this.saveImages(images);
    let target: Chat;
    try { target = await this.loadChat(recordToLoad); }
    catch (error) { if (this.deletedSessions.has(recordToLoad.id)) return; throw error; }
    if (this.deletedSessions.has(recordToLoad.id)) return;
    if (target?.running) {
      const message = { prompt: prompt.trim(), images: attachments };
      if (mode === 'queue') { target.queue.push(message); this.postQueue(target); return; }
      target.queue.unshift(message);
      this.postQueue(target);
      this.cancel(false, target.record.id);
      return;
    }
    if (fromQueue && !target) return;
    if (!displayed) display();
    if (this.active?.id === target.record.id && !fromQueue) {
      const selected = this.availableModel(this.selectedModel);
      const effective = selected && this.effectiveModel(selected);
      const effort = this.choiceFor(selected).effort;
      const account = selected && isOAuthProvider(selected.provider)
        ? selected.account && selected.account !== 'default' ? this.oauthAccounts.get(selected.account) : this.oauthAccounts.getDefault(selected.provider)
        : selected?.account && selected.account !== 'default' ? this.accounts.get(selected.account) : selected && this.accounts.getDefault(selected.provider);
      if (effective && (this.active.provider !== effective.provider || this.active.backend !== effective.backend || this.active.effort !== effort ||
        (effective.provider !== 'cursor-acp' && account && this.active.accountId !== account.id))) await this.switchModel(target);
    }
    const chat = target;
    const record = chat.record;
    const imageAttachments = attachments.filter(file => !!IMAGE_TYPES[file.mimeType]);
    const fileContext: string[] = [];
    for (const file of attachments) {
      const contextPath = join(chat.mirror.cwd, '.dsh', 'context', file.path.split(/[\\/]/).pop()!);
      await mkdir(dirname(contextPath), { recursive: true });
      await writeFile(contextPath, await readFile(file.path));
      fileContext.push(`${JSON.stringify(file.name)}: ${JSON.stringify(relative(chat.mirror.cwd, contextPath))} (${file.mimeType})`);
    }
    if (this.deletedSessions.has(record.id)) return;
    chat.cancelRequested = false;
    chat.turnEntryId = turnEntryId;
    chat.segment = 0;
    chat.startedTools.clear();
    chat.subagentIds.clear();
    chat.delegationToolIds.clear();
    chat.subagentText.clear();
    let segment = 0;
    let segmentHasText = false;
    const postText = (text: string): void => { if (!text) return; chat.turnReply += text; segmentHasText = true; this.sidebar.postMessage({ type: 'assistantDelta', sessionId: record.id, entryId: `assistant:${turnEntryId}:${segment}`, text }); };
    const breakMessage = (): void => { if (segmentHasText) { segment++; segmentHasText = false; } };
    const postTool = (id: string, title: string, detail: string | undefined, state: 'running' | 'complete' | 'error'): void => {
      if (isDelegationTool(title) || (title === 'MCP tool' && isDelegationTool(detail || ''))) { if (!chat.delegationToolIds.has(id)) breakMessage(); chat.delegationToolIds.add(id); }
      if (chat.delegationToolIds.has(id)) return;
      this.sidebar.postMessage({ type: 'toolEvent', sessionId: record.id, entryId: `tool:${turnEntryId}:${id}`, event: {
        id, kind: /search|grep|glob|web/i.test(title) ? 'search' : /edit|write/i.test(title) ? 'edit' : /command|bash|shell/i.test(title) ? 'shell' : /read/i.test(title) ? 'read' : 'other',
        title, detail, state,
      } });
      if (state === 'running') { segment++; segmentHasText = false; }
    };
    const postSubagent = (event: { id: string; title?: string; model?: string; prompt?: string; state?: 'running' | 'complete' | 'error'; text?: string; messageId?: string; role?: 'assistant' | 'tool' }): void => {
      this.sidebar.postMessage({ type: 'subagentEvent', sessionId: record.id, agentId: `${turnEntryId}:${event.id}`, ...event, model: event.model === 'default' ? record.modelName : event.model || record.modelName });
    };
    chat.running = true;
    started();
    this.postRun(record.id, 'thinking', 'Thinking…');
    this.updateStatus();
    const firstTurn = record.name === 'New chat' && !record.renamed;
    if (firstTurn) record.name = firstMessageTitle(prompt);
    record.updatedAt = Date.now();
    if (firstTurn && prompt.trim()) void this.autoName(record.id, prompt, chat.mirror.cwd);
    try {
      await this.saveSession(record);
      await chat.mirror.beginTurn();
      if (chat.cancelRequested) return;
      if (!isOAuthProvider(record.provider) && !chat.runtime?.isRunning) {
        const configured = this.availableModel(record.modelName);
        if (!configured) throw new Error('The model for this chat is no longer configured.');
        await this.switchModel(chat, { ...configured, provider: record.provider, backend: record.backend, account: record.accountId });
      }
      if (chat.cancelRequested) return;
      const history = this.transcripts.get(record.id) || [];
      this.transcripts.set(record.id, history);
      const handoff = chat.handoffPending && history.length
        ? `Earlier conversation, for context:\n${history.map(item => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.text}`).join('\n\n')}\n\n` : '';
      chat.handoffPending = false;
      history.push({ role: 'user', text: shown + (fileContext.length ? '\nContext files:\n' + fileContext.join('\n') : '') });
      chat.turnReply = '';
      const fullPrompt = `${handoff}${this.editorContext(chat.mirror.direct)}\n\n${delegationInstructions(!!this.delegateConfig(chat.ownerId))}\n\n${fileContext.length ? 'Attached context files (read as needed):\n' + fileContext.join('\n') + '\n\n' : ''}User request:\n${prompt}`;
      if (isOAuthProvider(record.provider)) {
        const account = this.oauthAccounts.get(record.accountId);
        if (!account) throw new Error('The selected OAuth account is missing. Connect it again.');
        await this.shareGlobalInstructions(account);
        if (chat.cancelRequested) return;
        record.cliSessionId = await chat.cli.prompt({ account, cwd: chat.mirror.cwd, backend: record.backend,
          prompt: fullPrompt, sessionId: record.cliSessionId, effort: record.effort, fullAccess: this.approvalMode === 'full', speed: this.choiceFor(this.availableModel(record.modelName)).speed,
          onText: postText,
          onMessageBreak: breakMessage,
          onTool: postTool,
          onSubagent: postSubagent,
          images: imageAttachments,
          delegate: this.delegateConfig(chat.ownerId),
          onApproval: (description, info) => this.decideApproval(chat, PARENT, description, info),
        });
        await this.saveSession(record);
      } else {
        if (!chat.runtime) throw new Error('This chat has no running agent. Use "DSH: Restart Runtime" and try again.');
        await chat.runtime.prompt(this.rid(record), fullPrompt, imageAttachments);
      }
    } catch (error) {
      if (!chat.cancelRequested) throw error;
    } finally {
      this.settleChatApprovals(record.id);
      if (chat.turnReply.trim()) this.transcripts.get(record.id)?.push({ role: 'assistant', text: chat.turnReply.trim() });
      chat.turnReply = '';
      await this.saveTranscripts();
      await chat.mirror.endTurn().catch(error => this.output.appendLine(`Mirror scan failed: ${String(error)}`));
      chat.running = false;
      this.postRun(record.id, 'idle', 'Ready');
      this.updateStatus();
      const next = chat.queue.shift();
      if (next) this.postQueue(chat);
      if (next && this.chats.get(record.id) === chat) void this.guarded(() => this.sendPrompt(next.prompt, undefined, next.images, record.id));
    }
  }

  private editorContext(direct: boolean): string {
    const folder = this.root();
    const scope = direct
      ? 'You are editing the user\'s workspace directly. The user and other agents may change files between turns, so re-read a file before editing it.'
      : 'Work within this working copy. Proposed edits will be reviewed in the IDE before they reach the source workspace.';
    if (!this.feature('editorContext')) {
      return ['IDE context:', scope, `Workspace: ${folder.name}`].join('\n');
    }
    const editor = vscode.window.activeTextEditor;
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).map(tab => {
      const input = tab.input;
      return input instanceof vscode.TabInputText ? relative(folder.uri.fsPath, input.uri.fsPath) : undefined;
    }).filter((item): item is string => !!item && !item.startsWith('..')).slice(0, 20);
    const parts = [
      'IDE context (paths are relative to the working copy):',
      scope,
      `Workspace: ${folder.name}`,
      `Open files: ${tabs.join(', ') || '(none)'}`,
    ];
    if (editor && editor.document.uri.scheme === 'file') {
      const path = relative(folder.uri.fsPath, editor.document.uri.fsPath);
      if (!path.startsWith('..')) {
        parts.push(`Active file: ${path}`, `Cursor: line ${editor.selection.active.line + 1}, column ${editor.selection.active.character + 1}`);
        if (!editor.selection.isEmpty) parts.push(`Selected text:\n${editor.document.getText(editor.selection).slice(0, 20000)}`);
        const diagnostics = vscode.languages.getDiagnostics(editor.document.uri).slice(0, 10);
        if (diagnostics.length) parts.push(`Diagnostics: ${diagnostics.map(d => `line ${d.range.start.line + 1}: ${d.message}`).join(' | ')}`);
      }
    }
    return parts.join('\n');
  }

  private mcpServers(ownerId?: string): unknown[] {
    const value = vscode.workspace.getConfiguration('dsh').get<unknown>('mcpServers', []);
    if (!Array.isArray(value)) throw new Error('dsh.mcpServers must be an array.');
    const delegate = ownerId ? this.delegateConfig(ownerId) : undefined;
    return delegate ? [...value, { name: DELEGATE_SERVER, command: delegate.command, args: delegate.args, env: Object.entries(delegate.env).map(([name, envValue]) => ({ name, value: envValue })) }] : value;
  }

  private subagentProfiles(): SubagentProfile[] {
    const value = vscode.workspace.getConfiguration('dsh').get<unknown>('subagents', []);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is SubagentProfile => !!item && typeof item === 'object' && typeof item.name === 'string' && !!item.name.trim()
      && typeof item.model === 'string' && item.enabled !== false)
      .map(item => ({ ...item, name: item.name.trim(), mode: item.mode === 'edit' ? 'edit' as const : 'read-only' as const }));
  }

  private refreshSubagents(): void {
    this.sidebar.postMessage({ type: 'subagentProfilesState', profiles: this.subagentProfiles().map(({ name, description, model, effort, speed, mode }) => ({ name, description, model, effort, speed, mode })) });
  }

  private async writeSubagents(profiles: SubagentProfile[]): Promise<void> {
    await vscode.workspace.getConfiguration('dsh').update('subagents', profiles, vscode.ConfigurationTarget.Global);
    this.refreshSubagents();
  }

  private async saveSubagent(message: Extract<SidebarWebviewMessage, { type: 'saveSubagent' }>): Promise<void> {
    const profile = message.profile;
    const name = String(profile.name || '').trim();
    const model = this.availableModel(String(profile.model || ''));
    if (!name || !model) throw new Error('Subagent needs a name and an available model.');
    if (profile.effort && !model.effortOptions?.includes(profile.effort)) throw new Error(`Effort "${profile.effort}" is not offered by ${model.name}.`);
    if (profile.speed && !model.speedOptions?.some(item => item.label === profile.speed)) throw new Error(`Speed "${profile.speed}" is not offered by ${model.name}.`);
    const next: SubagentProfile = { name, description: profile.description?.trim() || undefined, model: model.name, effort: profile.effort || undefined, speed: profile.speed || undefined, mode: profile.mode === 'edit' ? 'edit' : 'read-only' };
    const others = this.subagentProfiles().filter(item => item.name !== name && item.name !== message.originalName);
    await this.writeSubagents([...others, next]);
    this.sidebar.postMessage({ type: 'subagentSaved' });
  }

  private feature(key: SidebarFeatureKey): boolean {
    return vscode.workspace.getConfiguration('dsh').get<boolean>(FEATURE_SETTINGS[key], defaultFeatures()[key]) !== false;
  }

  private nameModelSetting(): SidebarNameModel {
    const value = vscode.workspace.getConfiguration('dsh').get<unknown>('nameModel');
    if (!value || typeof value !== 'object') return {};
    const { model, effort, speed } = value as Record<string, unknown>;
    const text = (item: unknown): string | undefined => typeof item === 'string' && item.trim() ? item.trim() : undefined;
    return { model: text(model), effort: text(effort), speed: text(speed) };
  }

  private refreshCustomize(): void {
    const features = Object.fromEntries((Object.keys(FEATURE_SETTINGS) as SidebarFeatureKey[]).map(key => [key, this.feature(key)])) as SidebarFeatures;
    this.sidebar.postMessage({ type: 'customizeState', features, nameModel: this.nameModelSetting(),
      accessibility: normalizeAccessibility(vscode.workspace.getConfiguration('dsh').get<unknown>('accessibility')) });
  }

  private async saveAccessibility(value: SidebarAccessibility): Promise<void> {
    await vscode.workspace.getConfiguration('dsh').update('accessibility', normalizeAccessibility(value), vscode.ConfigurationTarget.Global);
    this.refreshCustomize();
  }

  /** Deletes every chat that is not running. The open chat goes last so earlier deletions never switch to a chat about to be removed. */
  private async deleteAllSessions(): Promise<void> {
    const activeId = this.active?.id || this.context.workspaceState.get<string>(ACTIVE_SESSION_KEY);
    const ids = this.sessions().map(item => item.id).filter(id => !this.chats.get(id)?.running)
      .sort((a, b) => Number(a === activeId) - Number(b === activeId));
    for (const id of ids) await this.deleteSession(id);
  }

  private async setFeature(key: SidebarFeatureKey, enabled: boolean): Promise<void> {
    if (!Object.hasOwn(FEATURE_SETTINGS, key)) throw new Error('Unknown feature.');
    await vscode.workspace.getConfiguration('dsh').update(FEATURE_SETTINGS[key], enabled === true, vscode.ConfigurationTarget.Global);
    this.refreshCustomize();
  }

  private async saveNameModel(value: SidebarNameModel): Promise<void> {
    const name = String(value?.model || '').trim();
    let next: SidebarNameModel | undefined;
    if (name) {
      const model = this.availableModel(name);
      if (!model) throw new Error(`Model "${name}" is not available.`);
      const effort = value.effort || undefined;
      const speed = value.speed || undefined;
      if (effort && !model.effortOptions?.includes(effort)) throw new Error(`Effort "${effort}" is not offered by ${model.name}.`);
      if (speed && !model.speedOptions?.some(item => item.label === speed)) throw new Error(`Speed "${speed}" is not offered by ${model.name}.`);
      next = { model: model.name, effort, speed };
    }
    await vscode.workspace.getConfiguration('dsh').update('nameModel', next, vscode.ConfigurationTarget.Global);
    this.refreshCustomize();
  }

  /** Copies global rules and skills into a Claude/Codex account directory, or removes earlier copies when sharing is off. */
  private async shareGlobalInstructions(account: OAuthCliAccount): Promise<void> {
    try {
      const { dshHome, agentsHome } = this.instructionRoots();
      await shareInstructions(account.provider, account.directory, { dshHome, agentsHome }, this.feature('shareRules'));
    }
    catch (error) { this.output.appendLine(`Could not share global rules with ${runtimeLabel(account.provider)}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** Replaces a chat's first-message title with one from the configured name model. Failures keep the provisional title. */
  private async autoName(sessionId: string, prompt: string, cwd: string): Promise<void> {
    let choice: SidebarNameModel = {};
    try {
      choice = this.nameModelSetting();
      if (!this.feature('autoName') || !choice.model) return;
      const title = cleanChatTitle(await this.runOneShot({ ...choice, model: choice.model }, cwd, chatTitlePrompt(prompt)));
      const record = this.chats.get(sessionId)?.record ?? this.sessions().find(item => item.id === sessionId);
      if (!title || !record || record.renamed || this.deletedSessions.has(sessionId)) return;
      record.name = title;
      await this.saveSession(record, false);
    } catch (error) {
      this.output.appendLine(`Naming a chat with "${choice.model}" failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Runs one prompt on a configured model with tools denied, and returns the reply text. */
  private async runOneShot(choice: { model: string; effort?: string; speed?: string }, cwd: string, prompt: string, timeoutMs = 120_000): Promise<string> {
    const entry = this.availableModel(choice.model);
    if (!entry || entry.enabled === false) throw new Error(`Model "${choice.model}" is not available.`);
    const backend = entry.speedOptions?.find(item => item.label === choice.speed)?.backend || entry.backend;
    const route = await this.resolveRoute({ ...entry, backend });
    let reply = '';
    let timer: NodeJS.Timeout | undefined;
    const limit = (cancel: () => void): void => { timer = setTimeout(cancel, timeoutMs); };
    try {
      if ('oauthAccount' in route) {
        const cli = new OAuthCliRuntime();
        limit(() => cli.cancel());
        await cli.prompt({ account: route.oauthAccount, cwd, backend, effort: choice.effort, speed: choice.speed, readOnly: true, prompt,
          onText: text => { reply += text; }, onTool: () => undefined, onApproval: async () => 'Tools are not available for this request.' });
        return reply;
      }
      const slot = await this.ensureRuntime(route, cwd, `oneshot:${randomUUID()}`);
      if (!slot) throw new Error('No runtime is available for this model.');
      try {
        const sessionId = await slot.runtime.newSession(cwd, []);
        const listener = `${slot.key}\n${sessionId}`;
        this.oneShots.set(listener, update => {
          const content = update.content as Record<string, unknown> | undefined;
          if (update.sessionUpdate === 'agent_message_chunk' && content?.type === 'text' && typeof content.text === 'string') reply += content.text;
        });
        limit(() => slot.runtime.cancel(sessionId));
        try {
          if (route.model.provider === 'cursor-acp') {
            await this.refreshCursorModels(slot.runtime, sessionId);
            if (backend !== 'auto' || slot.runtime.models(sessionId).some(option => option.value === 'auto')) await slot.runtime.setModel(sessionId, backend);
          }
          if (choice.effort) await slot.runtime.setConfigOption(sessionId, 'reasoning_effort', choice.effort);
          await slot.runtime.prompt(sessionId, prompt);
        } finally {
          this.oneShots.delete(listener);
          await slot.runtime.closeSession(sessionId).catch(() => undefined);
        }
      } finally { await this.releaseRuntime(slot.key); }
      return reply;
    } finally { if (timer) clearTimeout(timer); }
  }

  private subagentInfos(): DelegateAgentInfo[] {
    return this.subagentProfiles().map(profile => ({ name: profile.name, description: profile.description, mode: profile.mode, model: profile.model }));
  }

  private delegateConfig(ownerId: string): { command: string; args: string[]; env: Record<string, string> } | undefined {
    const url = this.delegateHost.url;
    if (!url || !vscode.workspace.isTrusted) return undefined;
    const nodePath = vscode.workspace.getConfiguration('dsh').get<string>('runtime.nodePath') || undefined;
    return {
      command: nodePath || process.execPath,
      args: [join(this.context.extensionPath, 'dist', 'delegate-server.js')],
      env: { DSH_DELEGATE_URL: url, DSH_DELEGATE_TOKEN: this.delegateHost.token, DSH_DELEGATE_OWNER: ownerId, ...(nodePath ? {} : { ELECTRON_RUN_AS_NODE: '1' }) },
    };
  }

  private async handleDelegateCall(owner: string, tool: string, args: Record<string, unknown>): Promise<DelegateResult> {
    const chat = [...this.chats.values()].find(item => item.ownerId === owner);
    if (!chat) return { text: 'This chat is no longer active.', isError: true };
    if (chat.cancelRequested) return { text: 'Cancelled.', isError: true };
    if (tool === 'list_subagents') {
      const infos = this.subagentInfos();
      return { text: infos.length ? infos.map(info => `- ${info.name} (${info.mode}, model ${info.model})${info.description ? `: ${info.description}` : ''}`).join('\n') : 'No subagents are configured. Add them to the dsh.subagents setting.' };
    }
    if (tool === 'list_locked_files') {
      const locks = [...chat.locks];
      return { text: locks.length ? locks.map(([path, lock]) => `${path} (locked by subagent "${lock.label}")`).join('\n') : 'No files are locked.' };
    }
    if (tool === 'delegate_task') return this.runSubagent(chat, args);
    if (tool === 'ask_questions') return this.askQuestions(chat, args);
    if (this.toolpacks.owns(tool)) return this.toolpacks.call(tool, args);
    return { text: `Unknown tool "${tool}".`, isError: true };
  }

  private async runSubagent(chat: Chat, args: Record<string, unknown>): Promise<DelegateResult> {
    const fail = (text: string): DelegateResult => ({ text, isError: true });
    const name = typeof args.agent === 'string' ? args.agent.trim() : '';
    const task = typeof args.task === 'string' ? args.task.trim() : '';
    const profile = this.subagentProfiles().find(item => item.name === name);
    if (!profile) return fail(`Unknown subagent "${name}". Available: ${this.subagentInfos().map(info => info.name).join(', ') || '(none)'}.`);
    if (!task) return fail('"task" is required.');
    const entry = this.availableModel(profile.model);
    if (!entry || !entry.enabled) return fail(`Subagent "${name}" uses model "${profile.model}", which is not available.`);
    const speed = profile.speed ?? entry.speedOptions?.[0]?.label;
    const speedOption = entry.speedOptions?.find(item => item.label === speed);
    if (profile.speed && !speedOption) return fail(`Speed "${profile.speed}" is not an option for model "${entry.name}".`);
    if (profile.effort && !entry.effortOptions?.includes(profile.effort)) return fail(`Effort "${profile.effort}" is not an option for model "${entry.name}".`);
    const files = (Array.isArray(args.files) ? args.files : []).filter((item): item is string => typeof item === 'string')
      .map(item => item.replaceAll('\\', '/').replace(/^\.\//, '').trim()).filter(Boolean);
    const readOnly = profile.mode !== 'edit' || !files.length;
    if (files.some(item => item.startsWith('..') || isAbsolute(item))) return fail('"files" must be paths relative to the working copy.');
    const overlaps = (a: string, b: string): boolean => a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b));
    if (!readOnly) {
      const conflicts = files.flatMap(file => [...chat.locks].filter(([path]) => overlaps(path, file)).map(([path, lock]) => `${file} (locked by "${lock.label}" via ${path})`));
      if (conflicts.length) return fail(`Cannot lock: ${conflicts.join('; ')}. Wait for that subagent or choose other files.`);
    }
    const backend = speedOption?.backend || entry.backend;
    const model: ModelEntry = { ...entry, backend };
    const owner = `sub:${randomUUID()}`;
    const agentId = `${chat.turnEntryId}:delegate:${randomUUID()}`;
    const post = (event: { title?: string; prompt?: string; model?: string; state?: 'running' | 'complete' | 'error'; files?: string[]; text?: string; messageId?: string; role?: 'assistant' | 'tool' }): void => {
      this.sidebar.postMessage({ type: 'subagentEvent', sessionId: chat.record.id, agentId, ...event });
    };
    const run: ChildRun = { parent: chat, owner, label: profile.name, readOnly, changed: new Set(), outOfScope: new Set(), files: readOnly ? [] : files, cancel: () => undefined };
    this.childRuns.add(run); chat.children.add(run);
    if (!readOnly) for (const file of files) chat.locks.set(file, { owner, label: profile.name });
    const modelLabel = `${entry.name}${profile.effort ? ` · ${profile.effort}` : ''}${speed ? ` · ${speed}` : ''}`;
    post({ title: profile.name, prompt: task, model: modelLabel, state: 'running', files: readOnly ? [] : files });
    let reply = '';
    let cancelled = false;
    run.cancel = () => { cancelled = true; };
    const instructions = readOnly
      ? 'You are a READ-ONLY subagent. Do not modify, create or delete any files.'
      : `You may edit ONLY these paths: ${files.join(', ')}. Do not touch anything else; other agents are working in parallel.`;
    const prompt = `You are a subagent working in a shared working copy on behalf of another agent. ${instructions}\n\n${delegationInstructions(false)}\n\nTask:\n${task}\n\nWhen you finish, reply with a concise final report: findings, files changed, and anything the requester must still do.`;
    const onText = (text: string): void => { reply += text; post({ text, messageId: 'reply' }); };
    const onTool = (id: string, title: string, detail: string | undefined, state: 'running' | 'complete' | 'error'): void => {
      if (state === 'running') post({ text: `${title}${detail ? `: ${detail.slice(0, 300)}` : ''}`, messageId: `tool:${id}`, role: 'tool' });
    };
    try {
      const route = await this.resolveRoute(model);
      const effort = profile.effort || undefined;
      if ('oauthAccount' in route) {
        const cli = new OAuthCliRuntime();
        run.cancel = () => { cancelled = true; cli.cancel(); };
        await this.shareGlobalInstructions(route.oauthAccount);
        if (cancelled) throw new Error('Cancelled.');
        await cli.prompt({ account: route.oauthAccount, cwd: chat.mirror.cwd, backend, effort, speed, readOnly, fullAccess: this.approvalMode === 'full',
          prompt, onText, onTool, onApproval: (description, info) => this.decideApproval(chat, { owner, label: profile.name, readOnly }, description, info) });
      } else {
        const slot = await this.ensureRuntime(route, chat.mirror.cwd, owner);
        if (!slot) throw new Error('No runtime is available for this subagent model.');
        run.runtimeKey = slot.key;
        run.cancel = () => { cancelled = true; void slot.runtime.stop(); };
        if (cancelled) throw new Error('Cancelled.');
        const sessionId = await slot.runtime.newSession(chat.mirror.cwd, this.mcpServers());
        run.sessionId = sessionId;
        run.cancel = () => { cancelled = true; slot.runtime.cancel(sessionId); };
        const toolTexts = new Set<string>();
        run.onUpdate = update => {
          const kind = String(update.sessionUpdate || '');
          if (kind === 'agent_message_chunk') {
            const content = update.content as Record<string, unknown> | undefined;
            if (content?.type === 'text' && typeof content.text === 'string') onText(content.text);
          } else if (kind === 'tool_call' && typeof update.toolCallId === 'string' && !toolTexts.has(update.toolCallId)) {
            toolTexts.add(update.toolCallId);
            onTool(update.toolCallId, String(update.title || 'Tool'), undefined, 'running');
          }
        };
        try {
          if (route.model.provider === 'cursor-acp') {
            await this.refreshCursorModels(slot.runtime, sessionId);
            if (backend !== 'auto' || slot.runtime.models(sessionId).some(option => option.value === 'auto')) await slot.runtime.setModel(sessionId, backend);
          }
          if (effort) await slot.runtime.setConfigOption(sessionId, 'reasoning_effort', effort);
          if (cancelled) throw new Error('Cancelled.');
          await slot.runtime.prompt(sessionId, prompt);
        } finally {
          if (cancelled) await slot.runtime.stop();
          else await slot.runtime.closeSession(sessionId).catch(() => undefined);
        }
      }
      if (cancelled) throw new Error('Cancelled.');
      post({ state: 'complete' });
      let result = reply.trim() || '(The subagent finished without a written report.)';
      if (run.changed.size) {
        result += `\n\n---\nFiles changed by this subagent: ${[...run.changed].join(', ')}`;
        if (run.outOfScope.size) result += `\nWARNING: edits outside its locked paths (${files.join(', ') || 'none'}): ${[...run.outOfScope].join(', ')}`;
      } else if (!readOnly) {
        result += '\n\n---\nNo files were changed by this subagent.';
      }
      return { text: result };
    } catch (error) {
      post({ state: 'error' });
      const message = error instanceof Error ? error.message : String(error);
      let result = cancelled ? 'The subagent was cancelled.' : `Subagent "${name}" failed: ${message}`;
      if (run.changed.size) result += `\n\n---\nFiles changed by this subagent: ${[...run.changed].join(', ')}`;
      return { text: result, isError: true };
    } finally {
      for (const [path, lock] of [...chat.locks]) if (lock.owner === owner) chat.locks.delete(path);
      this.childRuns.delete(run); chat.children.delete(run);
      await this.releaseRuntime(run.runtimeKey);
    }
  }

  private cancel(clearQueue = true, chatId?: string): void {
    const chat = chatId ? this.chats.get(chatId) : this.chat;
    if (!chat) return;
    if (clearQueue && chat.queue.length) { chat.queue = []; this.postQueue(chat); }
    this.settleChatApprovals(chat.record.id);
    if (chat.running) {
      chat.cancelRequested = true;
      this.postRun(chat.record.id, 'cancelling', 'Cancelling…');
      for (const child of [...chat.children]) child.cancel();
      if (isOAuthProvider(chat.record.provider)) chat.cli.cancel(); else chat.runtime?.cancel(this.rid(chat.record));
    }
  }

  private async pickModel(): Promise<void> {
    const pick = await vscode.window.showQuickPick(this.availableModels().filter(model => model.enabled).map(model => ({
      label: model.name, description: `${model.provider} · ${model.backend}`, name: model.name,
    })), { placeHolder: 'Select a model' });
    if (pick) await this.selectModel(pick.name);
  }

  private async selectModel(name: string): Promise<void> {
    const model = this.availableModel(name);
    if (!model || !model.enabled) throw new Error(`Model '${name}' is unavailable.`);
    this.selectedModel = name;
    await this.context.workspaceState.update(SELECTED_MODEL_KEY, name);
    this.refreshModels(); await this.refreshAccount();
  }

  private async selectChoice(kind: 'speed' | 'effort', value: string): Promise<void> {
    const model = this.availableModel(this.selectedModel);
    if (!model) throw new Error('Choose a model first.');
    const valid = kind === 'speed'
      ? model.speedOptions?.some(item => item.label === value)
      : value === '' || model.effortOptions?.includes(value);
    if (!valid) throw new Error(`This ${kind} choice is unavailable for ${model.name}.`);
    this.modelChoices[model.name] = { ...this.modelChoices[model.name], [kind]: value };
    await this.context.workspaceState.update(MODEL_CHOICES_KEY, this.modelChoices);
    this.refreshModels();
  }

  private async manageAccounts(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.dsh');
    this.sidebar.postMessage({ type: 'showPage', page: 'accounts' });
    await this.refreshAccounts();
  }

  private async manageModels(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.dsh');
    this.sidebar.postMessage({ type: 'showPage', page: 'models' });
    this.refreshModels();
  }

  private async saveModel(message: Extract<SidebarWebviewMessage, { type: 'saveModel' }>): Promise<void> {
    const allowed = new Set(['deepseek-official', 'openai', 'anthropic', 'openrouter', 'cursor-acp', 'codex-cli', 'claude-cli']);
    if (!allowed.has(message.provider)) throw new Error('Choose a supported model provider.');
    const name = message.name.trim();
    const backend = message.backend.trim();
    if (!name || !backend || name.length > 80) throw new Error('A model name and backend ID are required.');
    const account = message.provider === 'cursor-acp' ? 'cursor-login' : message.account || 'default';
    const speedOptions = message.speedOptions || [];
    const effortOptions = message.effortOptions || [];
    if (!Array.isArray(speedOptions) || speedOptions.length > 8 || speedOptions.some(item =>
      !item || typeof item.label !== 'string' || typeof item.backend !== 'string' || !item.label.trim() || !item.backend.trim() || item.label.length > 30 || item.backend.length > 120) ||
      new Set(speedOptions.map(item => item.label.toLowerCase())).size !== speedOptions.length ||
      (speedOptions.length > 0 && (speedOptions[0].label !== 'None' || speedOptions[0].backend !== backend))) {
      throw new Error('Speed routes must have distinct names and valid model IDs.');
    }
    if (!Array.isArray(effortOptions) || effortOptions.length > 10 || effortOptions.some(item => typeof item !== 'string' || !/^[a-z][a-z0-9_-]{0,29}$/.test(item)) ||
      new Set(effortOptions).size !== effortOptions.length) throw new Error('Effort choices must be distinct provider effort values.');
    if (message.provider === 'cursor-acp' && backend !== 'auto' && !this.cursorModels.some(model => model.backend === backend)) {
      throw new Error('Start a Cursor session to load its available models before choosing one.');
    }
    if (message.provider === 'cursor-acp' && speedOptions.some(item => item.backend !== 'auto' && !this.cursorModels.some(model => model.backend === item.backend))) {
      throw new Error('A speed route uses a Cursor model that is not available. Start a Cursor session to refresh its models.');
    }
    if (message.provider !== 'cursor-acp' && account !== 'default' &&
      (isOAuthProvider(message.provider) ? this.oauthAccounts.get(account)?.provider : this.accounts.get(account)?.provider) !== message.provider) {
      throw new Error('The selected account does not belong to this provider.');
    }
    await this.models.set({ name, provider: message.provider, backend, account, enabled: true, speedOptions, effortOptions }, message.originalName);
    if (message.originalName && message.originalName !== name && this.modelChoices[message.originalName]) {
      this.modelChoices[name] = this.modelChoices[message.originalName];
      delete this.modelChoices[message.originalName];
      await this.context.workspaceState.update(MODEL_CHOICES_KEY, this.modelChoices);
    }
    if (message.originalName && this.selectedModel === message.originalName) {
      this.selectedModel = name;
      await this.context.workspaceState.update(SELECTED_MODEL_KEY, name);
      if (this.active && this.active.provider === message.provider && this.active.backend === backend &&
        (message.provider === 'cursor-acp' || this.active.accountId === (account === 'default' ?
          isOAuthProvider(message.provider) ? this.oauthAccounts.getDefault(message.provider)?.id : this.accounts.getDefault(message.provider)?.id : account))) {
        this.active.modelName = name;
        await this.saveSession(this.active);
      }
    }
    this.refreshModels();
    await this.refreshAccount();
    this.sidebar.postMessage({ type: 'modelSaved' });
  }

  private async removeModel(name: string): Promise<void> {
    if (!this.models.get(name)) throw new Error(`Model '${name}' is not configured.`);
    try { await this.models.remove(name); } catch (error) { this.sidebar.postMessage({ type: 'modelRemoveFailed', name }); this.refreshModels(); throw error; }
    if (this.selectedModel === name) {
      this.selectedModel = this.models.list(true)[0]?.name || '';
      await this.context.workspaceState.update(SELECTED_MODEL_KEY, this.selectedModel);
    }
    this.refreshModels();
    await this.refreshAccount();
  }

  private async removeAccount(accountId: string): Promise<void> {
    const affected = [...this.chats.values()].filter(chat => chat.record.accountId === accountId);
    if (affected.length) {
      if (affected.some(chat => chat.running)) throw new Error('Wait for running chats before removing their account.');
      if (affected.some(chat => chat.review.pending().length)) throw new Error('Apply or reject pending edits before removing the active account.');
      const wasActive = affected.some(chat => chat.record.id === this.active?.id);
      for (const chat of affected) await this.unloadChat(chat.record.id);
      if (wasActive) await this.context.workspaceState.update(ACTIVE_SESSION_KEY, undefined);
      this.refreshSessions();
      this.syncActiveView();
    }
    if (this.oauthAccounts.get(accountId)) await this.oauthAccounts.remove(accountId);
    else await this.accounts.remove(accountId);
    await this.refreshAccounts(false);
  }

  private async restartRuntime(): Promise<void> {
    for (const chat of this.chats.values()) this.cancel(true, chat.record.id);
    const id = this.active?.id;
    for (const [key, runtime] of [...this.runtimes]) { this.runtimes.delete(key); await runtime.stop(); runtime.dispose(); }
    for (const chat of [...this.chats.values()]) if (!chat.running || !isOAuthProvider(chat.record.provider)) { chat.runtime = undefined; chat.runtimeKey = undefined; await this.unloadChat(chat.record.id); }
    if (id) await this.continueChat(id);
  }

  private async reviewNext(): Promise<void> {
    const item = this.review?.pending()[0];
    if (item) await this.review?.open(item.id);
    else void vscode.window.showInformationMessage('DSH has no pending edits.');
  }

  private async openWorkingCopyTerminal(): Promise<void> {
    if (!this.active) await this.newChat();
    if (!this.active) return;
    const chat = await this.loadChat(this.active);
    const terminal = vscode.window.createTerminal({ name: 'DSH Working Copy', cwd: chat.mirror.cwd });
    terminal.show();
  }

  private onProposalsChanged(chatId: string, items: ReviewProposal[]): void {
    if (this.active?.id !== chatId) return;
    this.sidebar.postMessage({ type: 'diffState', diffs: this.diffItems(items) });
    this.updateStatus();
  }

  private diffItems(items: ReviewProposal[]): { id: string; path: string; summary: string; additions: number; deletions: number; state: ReviewProposal['state'] }[] {
    const lineCount = (value?: string): number => value ? value.split(/\r\n|\r|\n/).length - (/[\r\n]$/.test(value) ? 1 : 0) : 0;
    return items.map(item => ({
        id: item.id, path: item.path,
        summary: `${item.fromPath ? `Rename from ${item.fromPath}` : item.base === undefined ? 'Create' : item.proposed === undefined ? 'Delete' : `${item.hunks.length} hunk${item.hunks.length === 1 ? '' : 's'}`} · ${item.state}`,
        additions: item.base === undefined ? lineCount(item.proposed) : item.proposed === undefined ? 0 : item.hunks.reduce((sum, hunk) => sum + hunk.currentLines.length, 0),
        deletions: item.proposed === undefined ? lineCount(item.base) : item.base === undefined ? 0 : item.hunks.reduce((sum, hunk) => sum + hunk.baseLines.length, 0),
        state: item.state,
      }));
  }

  private onRuntimeUpdate(event: RuntimeEvent, key: string): void {
    const chat = this.chatForRuntime(event.sessionId, key);
    if (!chat) {
      const oneShot = this.oneShots.get(`${key}\n${event.sessionId}`);
      if (oneShot) oneShot(event.update);
      else [...this.childRuns].find(run => run.runtimeKey === key && run.sessionId === event.sessionId)?.onUpdate?.(event.update);
      return;
    }
    const chatId = chat.record.id;
    if (chat.cancelRequested) return;
    const update = event.update;
    const kind = String(update.sessionUpdate || '');
    if (kind === 'cursor_task') {
      const id = String(update.toolCallId || update.agentId || Date.now());
      chat.subagentIds.add(id);
      this.sidebar.postMessage({ type: 'subagentEvent', sessionId: chatId, agentId: `${chat.turnEntryId}:${id}`,
        title: typeof update.description === 'string' ? update.description : 'Subagent',
        prompt: typeof update.prompt === 'string' ? update.prompt : undefined,
        model: typeof update.model === 'string' ? update.model : chat.record.modelName,
        state: typeof update.durationMs === 'number' ? 'complete' : 'running' });
      return;
    }
    if (kind === 'config_option_update' && chat.record.provider === 'cursor-acp' && chat.runtime) void this.refreshCursorModels(chat.runtime, event.sessionId);
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const content = update.content as Record<string, unknown> | undefined;
      if (content?.type === 'text' && typeof content.text === 'string' && kind === 'agent_message_chunk') {
        chat.turnReply += content.text;
        this.sidebar.postMessage({ type: 'assistantDelta', sessionId: chatId, entryId: `assistant:${chat.turnEntryId}:${chat.segment}`, text: content.text });
      }
    } else if (kind.startsWith('tool_call')) {
      const id = String(update.toolCallId || Date.now());
      const title = String(update.title || 'Tool');
      if (isDelegationTool(title)) { if (!chat.delegationToolIds.has(id)) chat.segment++; chat.delegationToolIds.add(id); }
      // Delegation has its own card, posted by runSubagent rather than this MCP call.
      if (chat.delegationToolIds.has(id)) return;
      const alreadyKnown = chat.subagentIds.has(id);
      if (/^(subagent(?: activity)?|task)$/i.test(title)) chat.subagentIds.add(id);
      if (chat.subagentIds.has(id)) {
        const contents = Array.isArray(update.content) ? update.content as Record<string, unknown>[] : [];
        const currentText = contents.filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text as string).join('\n');
        const previousText = chat.subagentText.get(id) || '';
        const text = currentText.startsWith(previousText) ? currentText.slice(previousText.length) : currentText === previousText ? '' : currentText;
        if (currentText) chat.subagentText.set(id, currentText);
        this.sidebar.postMessage({ type: 'subagentEvent', sessionId: chatId, agentId: `${chat.turnEntryId}:${id}`,
          title: alreadyKnown ? undefined : title,
          model: chat.record.modelName,
          state: update.status === 'failed' ? 'error' : kind === 'tool_call' || update.status === 'in_progress' ? 'running' : 'complete',
          ...(text ? { text, messageId: `update:${id}` } : {}) });
        return;
      }
      const rawKind = String(update.kind || 'other').toLowerCase();
      const toolKind = /search|grep|glob|web/.test(rawKind + ' ' + title) ? 'search'
        : /edit|write|patch/.test(rawKind + ' ' + title) ? 'edit'
        : /shell|command|bash|powershell/.test(rawKind + ' ' + title) ? 'shell'
        : /read|file/.test(rawKind + ' ' + title) ? 'read' : 'other';
      const locations = Array.isArray(update.locations) ? update.locations as Record<string, unknown>[] : [];
      const location = locations.find(item => typeof item.path === 'string')?.path;
      const detail = typeof location === 'string' ? location : typeof update.status === 'string' ? update.status : undefined;
      if (!chat.startedTools.has(id)) { chat.startedTools.add(id); chat.segment++; }
      this.sidebar.postMessage({ type: 'toolEvent', sessionId: chatId, entryId: `tool:${chat.turnEntryId}:${id}`, event: {
        id, kind: toolKind, title, detail,
        state: update.status === 'failed' ? 'error' : kind === 'tool_call' || update.status === 'in_progress' ? 'running' : 'complete',
      } });
      if (chat.running) this.postRun(chatId, 'tool', 'Using tools…');
    }
  }

  private async requestPermission(params: Record<string, unknown>, key: string): Promise<string | undefined> {
    if (!vscode.workspace.isTrusted) return undefined;
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    const chat = this.chatForRuntime(sessionId, key);
    const child = chat ? undefined : [...this.childRuns].find(run => run.runtimeKey === key && run.sessionId === sessionId);
    const parent = chat ?? child?.parent;
    const tool = params.toolCall as Record<string, unknown> | undefined;
    const options = Array.isArray(params.options) ? params.options as Record<string, unknown>[] : [];
    const allow = options.find(option => option.kind === 'allow_once');
    const reject = options.find(option => option.kind === 'reject_once');
    const title = typeof tool?.title === 'string' ? tool.title : 'DSH tool';
    if (!parent) return reject ? String(reject.optionId || '') : undefined;
    const locations = Array.isArray(tool?.locations) ? tool.locations as Record<string, unknown>[] : [];
    const path = locations.find(item => typeof item.path === 'string')?.path;
    const isEdit = ['edit', 'delete', 'move'].includes(String(tool?.kind || ''));
    const actor: Actor = child ? { owner: child.owner, label: child.label, readOnly: child.readOnly } : PARENT;
    const detail = `${title} ${JSON.stringify(tool?.rawInput ?? tool?.content ?? '')}`;
    const verdict = await this.decideApproval(parent, actor, detail, isEdit ? { tool: 'Edit', input: { file_path: typeof path === 'string' ? path : undefined } } : { tool: title, input: {} });
    return verdict === true ? String(allow?.optionId || '') : reject ? String(reject.optionId || '') : undefined;
  }

  private async decideApproval(chat: Chat, actor: Actor, description: string, info?: ToolInfo): Promise<boolean | string> {
    const verdict = await this.decideApprovalInner(chat, actor, description, info);
    if (verdict === true && info && EDIT_TOOLS.test(info.tool) && actor.owner !== PARENT.owner) {
      const rel = this.relPath(chat, info.input);
      const run = [...this.childRuns].find(item => item.owner === actor.owner);
      if (rel && run) {
        run.changed.add(rel);
        if (!run.files.some(file => rel === file || (file.endsWith('/') && rel.startsWith(file)))) run.outOfScope.add(rel);
      }
    }
    return verdict;
  }

  private async decideApprovalInner(chat: Chat, actor: Actor, description: string, info?: ToolInfo): Promise<boolean | string> {
    if (chat.cancelRequested) return false;
    if (!vscode.workspace.isTrusted) return false;
    if (info && isNativeSubagentTool(info.tool)) return 'Use DSH delegate_task with a configured subagent profile.';
    if (info && EDIT_TOOLS.test(info.tool)) {
      if (actor.readOnly) return 'This subagent is read-only and may not edit files.';
      const path = this.relPath(chat, info.input);
      const conflict = path ? this.lockConflict(chat, path, actor.owner) : undefined;
      if (conflict) return `"${path}" is locked by subagent "${conflict.label}" until it finishes. Edit other files or wait.`;
      if (info.autoAllowEdits) return true;
    }
    if (this.approvalMode === 'full' || (this.approvalMode === 'auto' && !isRiskyAction(description))) return true;
    return this.askInChat(chat.record.id, actor.owner === PARENT.owner ? 'Permission requested' : `Subagent "${actor.label}" requests permission`, description);
  }

  private relPath(chat: Chat, input: Record<string, unknown>): string | undefined {
    const raw = [input.file_path, input.notebook_path, input.path].find((value): value is string => typeof value === 'string' && !!value);
    if (!raw) return undefined;
    const rel = (isAbsolute(raw) ? relative(chat.mirror.cwd, raw) : raw).replaceAll('\\', '/').replace(/^\.\//, '');
    return rel.startsWith('..') ? undefined : rel;
  }

  private lockConflict(chat: Chat, rel: string, owner: string): { owner: string; label: string } | undefined {
    for (const [path, lock] of chat.locks) if (lock.owner !== owner && (rel === path || (path.endsWith('/') && rel.startsWith(path)))) return lock;
    return undefined;
  }

  private async handleCursorRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method === 'cursor/ask_question') {
      const questions = Array.isArray(params.questions) ? params.questions as Record<string, unknown>[] : [];
      const answers: { questionId: string; selectedOptionIds: string[] }[] = [];
      for (const question of questions) {
        const options = Array.isArray(question.options) ? question.options as Record<string, unknown>[] : [];
        const items = options.filter(option => typeof option.id === 'string' && typeof option.label === 'string')
          .map(option => ({ label: option.label as string, id: option.id as string }));
        const placeHolder = typeof question.prompt === 'string' ? question.prompt : 'Choose an answer';
        if (question.allowMultiple) {
          const picked = await vscode.window.showQuickPick(items, { placeHolder, canPickMany: true });
          if (!picked) return { outcome: { outcome: 'skipped' } };
          answers.push({ questionId: String(question.id), selectedOptionIds: picked.map(item => item.id) });
        } else {
          const picked = await vscode.window.showQuickPick(items, { placeHolder });
          if (!picked) return { outcome: { outcome: 'skipped' } };
          answers.push({ questionId: String(question.id), selectedOptionIds: [picked.id] });
        }
      }
      return { outcome: { outcome: 'answered', answers } };
    }
    if (method === 'cursor/create_plan') {
      const title = typeof params.name === 'string' ? params.name : 'Cursor plan';
      const plan = typeof params.plan === 'string' ? params.plan : '';
      const choice = await vscode.window.showInformationMessage(title, { modal: true, detail: plan.slice(0, 15000) }, 'Accept plan', 'Reject plan');
      return { outcome: { outcome: choice === 'Accept plan' ? 'accepted' : choice === 'Reject plan' ? 'rejected' : 'cancelled' } };
    }
    throw new Error(`Unsupported Cursor request: ${method}`);
  }

  private async onSidebarMessage(message: SidebarWebviewMessage): Promise<void> {
    await this.guarded(async () => {
      switch (message.type) {
        case 'checkDependencies': await this.refreshDependencies(); break;
        case 'installProvider': await this.installProvider(message.provider); break;
        case 'pageChanged': this.sidebar.setPage(message.page); if (message.page === 'instructions') await this.refreshInstructions(); break;
        case 'ready': await this.refreshInstructions(); this.postToolpacks(); this.sidebar.postMessage({ type: 'approvalState', mode: this.approvalMode }); this.refreshCustomize(); this.refreshSubagents(); this.refreshModels(); this.refreshSessions(); await this.refreshAccount(); await this.refreshAccounts(); break;
        case 'sendPrompt': await this.sendPrompt(message.prompt, message.images, undefined, undefined, message.mode === 'queue' ? 'queue' : 'interrupt'); break;
        case 'unqueue': { const target = this.chats.get(message.sessionId); if (target && Number.isInteger(message.index)) { target.queue.splice(message.index, 1); this.postQueue(target); } break; }
        case 'editMessage': await this.editMessage(message.sessionId, message.entryId, message.text); break;
        case 'readInstruction': this.sidebar.postMessage({ type: 'instructionContent', id: message.id, content: await readInstruction(this.instructionRoots(), message.id) }); break;
        case 'openInstruction': await vscode.window.showTextDocument(vscode.Uri.file(await locateInstruction(this.instructionRoots(), message.id))); break;
        case 'saveInstruction': await this.saveInstructionRequest(message); break;
        case 'removeInstruction': await this.removeInstructionRequest(message.id); break;
        case 'approvalResponse': this.settleApproval(message.id, message.allow === true); break;
        case 'questionResponse': this.settleQuestion(message.id, Array.isArray(message.answers) ? message.answers.map(item => String(item)) : null); break;
        case 'pickToolpack': await this.addToolpack(); break;
        case 'setFeature': await this.setFeature(message.key, message.enabled); break;
        case 'saveNameModel': await this.saveNameModel(message.nameModel); break;
        case 'saveAccessibility': await this.saveAccessibility(message.accessibility); break;
        case 'deleteAllSessions': await this.deleteAllSessions(); break;
        case 'toolpackAction':
          if (message.action === 'remove') await this.toolpacks.remove(message.id);
          else if (message.action === 'reload') await this.toolpacks.reload(message.id);
          else await this.toolpacks.setEnabled(message.id, message.action === 'enable');
          this.postToolpacks();
          break;
        case 'setApproval':
          this.approvalMode = message.mode === 'auto' || message.mode === 'full' ? message.mode : 'ask';
          await this.context.workspaceState.update(APPROVAL_KEY, this.approvalMode);
          this.sidebar.postMessage({ type: 'approvalState', mode: this.approvalMode });
          break;
        case 'applyAll': await this.review?.applyAll(); break;
        case 'rejectAll': await this.review?.rejectAll(); break;
        case 'cancel': this.cancel(); break;
        case 'newSession': await this.newChat(); break;
        case 'selectSession': await this.continueChat(message.sessionId); break;
        case 'deleteSession': await this.deleteSession(message.sessionId); break;
        case 'renameSession': {
          // Prefer the loaded chat's record so a later turn save does not restore the old name.
          const record = this.chats.get(message.sessionId)?.record ?? this.sessions().find(item => item.id === message.sessionId);
          if (record) {
            const name = message.name.trim() || await vscode.window.showInputBox({ prompt: 'Session name', value: record.name });
            if (name?.trim()) { record.name = name.trim().slice(0, 100); record.renamed = true; await this.saveSession(record, false); }
          }
          break;
        }
        case 'selectModel': await this.selectModel(message.modelId); break;
        case 'selectSpeed': await this.selectChoice('speed', message.value); break;
        case 'selectEffort': await this.selectChoice('effort', message.value); break;
        case 'saveSubagent': await this.saveSubagent(message); break;
        case 'removeSubagent': await this.writeSubagents(this.subagentProfiles().filter(item => item.name !== message.name)); break;
        case 'saveModel': await this.saveModel(message); break;
        case 'removeModel': await this.removeModel(message.name); break;
        case 'manageAccounts': await this.manageAccounts(); break;
        case 'refreshAccounts': await this.refreshAccounts(); break;
        case 'viewProviderUsage': {
          const url = PROVIDER_USAGE_URLS.get(message.provider);
          if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
          break;
        }
        case 'addAccount': {
          if (!['deepseek-official', 'openrouter'].includes(message.provider)) throw new Error('Choose a supported API provider.');
          await this.accounts.add({ provider: message.provider, label: message.label, email: message.email, secret: message.secret });
          await this.refreshAccounts(false);
          this.sidebar.postMessage({ type: 'accountSaved' });
          break;
        }
        case 'addOAuthAccount':
          await this.ensureNode();
          await this.refreshDependencies();
          await this.oauthAccounts.add(message.provider, message.label, message.email);
          await this.refreshAccounts(false);
          this.sidebar.postMessage({ type: 'accountSaved' });
          break;
        case 'setDefaultAccount':
          if (isOAuthProvider(message.provider)) await this.oauthAccounts.setDefault(message.provider, message.accountId);
          else await this.accounts.setDefault(message.provider, message.accountId);
          await this.refreshAccounts(false);
          break;
        case 'removeAccount': await this.removeAccount(message.accountId); break;
        case 'cursorLogin': await this.cursorLogin(); break;
        case 'cursorLogout': await this.cursorLogout(); break;
        case 'openAuthUrl': if (this.safeCursorAuthUrl(message.url) && message.url === this.cursorAccount.authUrl) await vscode.env.openExternal(vscode.Uri.parse(message.url)); break;
        case 'openFile': {
          const item = this.review?.pending().find(diff => diff.path === message.path);
          if (item) await this.review?.open(item.id);
          else if (this.mirror) {
            const editor = await vscode.window.showTextDocument(this.mirror.uri(message.path));
            if (message.line && Number.isInteger(message.line) && message.line > 0) {
              const position = new vscode.Position(message.line - 1, Math.max(0, (message.column || 1) - 1));
              editor.selection = new vscode.Selection(position, position);
              editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            }
          }
          break;
        }
        case 'applyDiff': await this.review?.apply(message.diffId); break;
        case 'openDiff': await this.review?.open(message.diffId); break;
        case 'rejectDiff': await this.review?.reject(message.diffId); break;
        case 'reviewAll': await this.review?.openAll(); break;
        case 'openTerminal': await this.openWorkingCopyTerminal(); break;
      }
    });
  }
}

let host: ExtensionHost | undefined;

export function activate(context: vscode.ExtensionContext): void {
  host = new ExtensionHost(context);
  context.subscriptions.push(host);
}

export function deactivate(): void { host?.dispose(); host = undefined; }
