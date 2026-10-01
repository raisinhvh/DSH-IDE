import { dshBinFrom } from '../update/dshUpdate';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { AgentModel, agentModels } from './models';
import { cancellationDeadline, terminateProcessTree } from './cancellation';

type Json = Record<string, unknown>;
type Pending = { resolve(value: Json): void; reject(error: Error): void; timer?: NodeJS.Timeout; method: string; sessionId?: string; clearCancellation?: () => void };

export interface DshRuntimeRoute {
  kind: 'dsh';
  provider: string;
  model: string;
  apiKey: string;
  webSearchKey?: string;
  home: string;
  nodePath?: string;
  /** Folder holding a downloaded DSH update; the bundled DSH is used when absent. */
  dshRoot?: string;
  envName: string;
}

export interface CursorRuntimeRoute {
  kind: 'cursor';
  command: string;
  args: string[];
  cwd: string;
}

export type RuntimeRoute = DshRuntimeRoute | CursorRuntimeRoute;

export interface RuntimeEvent {
  sessionId: string;
  update: Json;
}

export type PermissionHandler = (params: Json) => Promise<string | undefined>;
export type CursorRequestHandler = (method: string, params: Json) => Promise<Json>;

/** Owns a single local DSH ACP stdio process. The wire is JSON-RPC 2.0, one frame per line. */
export class AcpRuntime implements vscode.Disposable {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private stderrBuffer = '';
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private secrets: string[] = [];
  private startPromise?: Promise<void>;
  private closed = false;
  private kind: 'dsh' | 'cursor' = 'dsh';
  private readonly modelOptions = new Map<string, AgentModel[]>();
  private readonly configOptions = new Map<string, Json[]>();
  private activeSessionId?: string;
  private readonly updates = new vscode.EventEmitter<RuntimeEvent>();
  private readonly state = new vscode.EventEmitter<'starting' | 'ready' | 'stopped'>();
  public readonly onUpdate = this.updates.event;
  public readonly onState = this.state.event;

  public constructor(
    private readonly output: vscode.OutputChannel,
    private readonly permission: PermissionHandler,
    private readonly cursorRequest?: CursorRequestHandler,
  ) {}

  public get isRunning(): boolean { return !!this.child && !this.closed; }

  public async start(route: RuntimeRoute): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.closed = false;
    this.startPromise = this.launch(route);
    try { await this.startPromise; }
    catch (error) { await this.stop(); this.startPromise = undefined; throw error; }
  }

  private async launch(route: RuntimeRoute): Promise<void> {
    this.state.fire('starting');
    this.kind = route.kind;
    this.stderrBuffer = '';
    let command: string;
    let args: string[];
    let cwd: string;
    let env: NodeJS.ProcessEnv = { ...process.env };
    if (route.kind === 'dsh') {
      await mkdir(route.home, { recursive: true });
      const patch = join(route.home, 'ide-acp.patch.yml');
      // Keep runtime persistence isolated while using DSH's own global rules
      // and skill discovery. Compaction remains owned by dsh-base's defaults.
      const instructionsHome = process.env.DSH_HOME || join(homedir(), '.dsh');
      await writeFile(patch, `- id: acp\n  config:\n    provider: ${JSON.stringify(route.provider)}\n    model: ${JSON.stringify(route.model)}\n- id: agent-instructions\n  config:\n    maxBytes: 65536\n    dshHome: ${JSON.stringify(instructionsHome)}\n- id: skill-filesystem\n  config:\n    dshHome: ${JSON.stringify(instructionsHome)}\n`, 'utf8');
      const dshBin = dshBinFrom(route.dshRoot);
      this.secrets = [route.apiKey, route.webSearchKey].filter((value): value is string => !!value);
      env = { ...env, DSH_HOME: route.home, [route.envName]: route.apiKey, ...(route.webSearchKey ? { DEEPSEEK_API_KEY: route.webSearchKey } : {}) };
      command = route.nodePath || 'node';
      args = [dshBin, '--profile', 'acp', '--patch', patch];
      cwd = dirname(dshBin);
    } else {
      this.secrets = [];
      command = route.command;
      args = route.args;
      cwd = route.cwd;
    }
    this.child = spawn(command, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const child = this.child;
    child.stdin.on('error', error => { if (this.child === child) this.fail(error); });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => { if (this.child === child) this.read(chunk); });
    this.child.stderr.on('data', (chunk: string) => { if (this.child === child) this.readStderr(chunk); });
    this.child.on('error', error => { if (this.child === child) this.fail(error); });
    this.child.on('exit', (code, signal) => { if (this.child === child) this.fail(new Error(`${this.kind === 'cursor' ? 'Cursor Agent' : 'DSH'} runtime exited (${code ?? signal ?? 'unknown'}). Open Runtime Logs for details.`)); });
    await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'dsh-ide', version: '0.4.3' },
    }, 30000);
    if (route.kind === 'cursor') {
      try { await this.request('authenticate', { methodId: 'cursor_login' }, 30000); }
      catch (error) { throw new Error(`Cursor sign-in failed. Run "agent login" in a terminal, then retry. ${error instanceof Error ? error.message : String(error)}`); }
    }
    this.state.fire('ready');
  }

  public async newSession(cwd: string, mcpServers: unknown[] = []): Promise<string> {
    const result = await this.request('session/new', { cwd, mcpServers });
    if (typeof result.sessionId !== 'string') throw new Error('Agent returned no session ID.');
    this.recordModels(result.sessionId, result);
    this.activeSessionId = result.sessionId;
    return result.sessionId;
  }

  public async resumeSession(sessionId: string, cwd: string, mcpServers: unknown[] = []): Promise<void> {
    const result = await this.request(this.kind === 'cursor' ? 'session/load' : 'session/resume', { sessionId, cwd, mcpServers });
    this.recordModels(sessionId, result);
    this.activeSessionId = sessionId;
  }

  public models(sessionId: string): AgentModel[] { return this.modelOptions.get(sessionId) || []; }

  private recordModels(sessionId: string, value: Json): void {
    const models = agentModels(value);
    if (models.length) this.modelOptions.set(sessionId, models);
    if (Array.isArray(value.configOptions)) this.configOptions.set(sessionId, value.configOptions as Json[]);
  }

  public async listSessions(cwd?: string): Promise<Json[]> {
    const result = await this.request('session/list', cwd ? { cwd } : {});
    return Array.isArray(result.sessions) ? result.sessions as Json[] : [];
  }

  public async setModel(sessionId: string, model: string): Promise<void> {
    const options = this.models(sessionId);
    if (!options.some(option => option.value === model)) throw new Error(`Model '${model}' is unavailable in this agent session.`);
    const result = await this.request('session/set_config_option', { sessionId, configId: 'model', value: model });
    this.recordModels(sessionId, result);
  }

  public async setConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    const option = this.configOptions.get(sessionId)?.find(item => item.id === configId);
    const choices = Array.isArray(option?.options) ? option.options as Json[] : [];
    const flattened = choices.flatMap(item => Array.isArray(item.options) ? item.options as Json[] : [item]);
    if (!flattened.some(item => item.value === value)) {
      throw new Error(`${configId} '${value}' is unavailable for this model. Edit its effort choices or choose Default.`);
    }
    const result = await this.request('session/set_config_option', { sessionId, configId, value });
    this.recordModels(sessionId, result);
  }

  public prompt(sessionId: string, text: string, images: { mimeType: string; data: string }[] = []): Promise<Json> {
    this.activeSessionId = sessionId;
    const blocks = [{ type: 'text', text }, ...images.map(image => ({ type: 'image', mimeType: image.mimeType, data: image.data }))];
    return this.request('session/prompt', { sessionId, prompt: blocks });
  }

  public cancel(sessionId: string): void {
    for (const pending of this.pending.values()) {
      if (pending.method === 'session/prompt' && pending.sessionId === sessionId && !pending.clearCancellation) {
        pending.clearCancellation = cancellationDeadline(() => {
          this.output.appendLine('Agent did not finish cancellation within 2 seconds; stopping its runtime.');
          void this.stop();
        });
      }
    }
    try { this.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }); }
    catch { void this.stop(); }
  }

  public async closeSession(sessionId: string): Promise<void> {
    if (this.kind === 'cursor') return;
    await this.request('session/close', { sessionId }, 10000);
  }

  public async stop(): Promise<void> {
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    this.startPromise = undefined;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.clearCancellation?.();
      pending.reject(new Error('DSH runtime stopped.'));
    }
    this.pending.clear();
    this.modelOptions.clear();
    this.configOptions.clear();
    this.activeSessionId = undefined;
    if (child) terminateProcessTree(child);
    this.buffer = '';
    this.stderrBuffer = '';
    this.state.fire('stopped');
  }

  public dispose(): void {
    void this.stop();
    this.updates.dispose();
    this.state.dispose();
  }

  private request(method: string, params: Json, timeoutMs?: number): Promise<Json> {
    const child = this.child;
    if (!child) return Promise.reject(new Error('DSH runtime is not running.'));
    return this.requestOnChild(child, method, params, timeoutMs);
  }

  private requestOnChild(child: ChildProcessWithoutNullStreams, method: string, params: Json, timeoutMs?: number): Promise<Json> {
    const id = this.nextId++;
    return new Promise<Json>((resolve, reject) => {
      const pending: Pending = { resolve, reject, method, sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined };
      if (timeoutMs) pending.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DSH ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, pending);
      try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
      catch (error) { this.pending.delete(id); if (pending.timer) clearTimeout(pending.timer); reject(error as Error); }
    });
  }

  private send(frame: Json): void {
    if (!this.child || this.closed) return;
    this.child.stdin.write(JSON.stringify(frame) + '\n');
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 10_000_000) { this.fail(new Error('DSH protocol frame exceeded 10 MB.')); return; }
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let frame: Json;
      try { frame = JSON.parse(line) as Json; }
      catch { this.output.appendLine('DSH sent a non-JSON protocol line.'); continue; }
      void this.dispatch(frame);
    }
  }

  private async dispatch(frame: Json): Promise<void> {
    const child = this.child;
    const reply = (response: Json): void => { if (this.child === child) this.send(response); };
    const id = frame.id;
    const method = frame.method;
    if ((typeof id === 'number' || typeof id === 'string') && typeof method === 'string') {
      if (method === 'session/request_permission') {
        let optionId: string | undefined;
        try { optionId = await this.permission((frame.params || {}) as Json); }
        catch (error) { this.output.appendLine(this.redact(String(error))); }
        reply({ jsonrpc: '2.0', id, result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } } });
      } else if (method.startsWith('cursor/') && this.cursorRequest) {
        try { reply({ jsonrpc: '2.0', id, result: await this.cursorRequest(method, (frame.params || {}) as Json) }); }
        catch (error) { reply({ jsonrpc: '2.0', id, error: { code: -32000, message: this.redact(String(error)) } }); }
      } else reply({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not supported by IDE client' } });
      return;
    }
    if (typeof id === 'number' || typeof id === 'string') {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.clearCancellation?.();
      if (frame.error) {
        const error = frame.error as Json;
        pending.reject(new Error(this.redact(String(error.message || 'DSH request failed.'))));
      } else pending.resolve((frame.result || {}) as Json);
      return;
    }
    if (method === 'cursor/task' && this.activeSessionId) {
      this.updates.fire({ sessionId: this.activeSessionId, update: { ...(frame.params as Json || {}), sessionUpdate: 'cursor_task' } });
    } else if (method === 'session/update') {
      const params = (frame.params || {}) as Json;
      if (typeof params.sessionId === 'string' && params.update && typeof params.update === 'object') {
        const update = params.update as Json;
        if (update.sessionUpdate === 'config_option_update') this.recordModels(params.sessionId, update);
        this.updates.fire({ sessionId: params.sessionId, update: params.update as Json });
      }
    }
  }

  private fail(error: Error): void {
    const child = this.child;
    if (this.stderrBuffer) {
      this.output.appendLine(this.redact(this.stderrBuffer));
      this.stderrBuffer = '';
    }
    this.output.appendLine(this.redact(error.message));
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.clearCancellation?.();
      pending.reject(error);
    }
    this.pending.clear();
    this.child = undefined;
    this.startPromise = undefined;
    if (child) terminateProcessTree(child);
    this.buffer = '';
    this.state.fire('stopped');
  }

  private redact(value: string): string {
    return this.secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);
  }

  private readStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    if (this.stderrBuffer.length > 1_000_000) {
      this.output.appendLine('DSH emitted an overlong log line; it was omitted.');
      this.stderrBuffer = '';
      return;
    }
    let end: number;
    while ((end = this.stderrBuffer.indexOf('\n')) >= 0) {
      const line = this.stderrBuffer.slice(0, end);
      this.stderrBuffer = this.stderrBuffer.slice(end + 1);
      this.output.appendLine(this.redact(line));
    }
  }
}
