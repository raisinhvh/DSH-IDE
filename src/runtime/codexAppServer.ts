import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { cliCommand, cliEnv } from '../accounts/oauthCli';
import type { CliTurn } from './oauthCli';
import { delegationInstructions } from './delegation';
import { codexServiceTier } from './models';
import { cancellationDeadline, terminateProcessTree } from './cancellation';

type Json = Record<string, unknown>;

/** Codex homes whose Windows sandbox is already set up in this process. */
const windowsSandboxReady = new Set<string>();

/** One Codex app-server connection per turn, using the CLI account's OAuth profile. */
export class CodexAppServerRuntime {
  private child?: ChildProcessWithoutNullStreams;
  private interrupt?: () => void;
  private cancelled = false;

  cancel(): void {
    this.cancelled = true;
    if (this.interrupt) this.interrupt();
    else if (this.child) terminateProcessTree(this.child);
  }

  async prompt(turn: CliTurn): Promise<string | undefined> {
    if (this.child) throw new Error('A Codex turn is already running.');
    this.cancelled = false;
    const toml = (value: unknown): string => JSON.stringify(value);
    const delegateArgs = turn.delegate ? [
      '-c', `mcp_servers.dsh-delegate.command=${toml(turn.delegate.command)}`,
      '-c', `mcp_servers.dsh-delegate.args=${toml(turn.delegate.args)}`,
      '-c', `mcp_servers.dsh-delegate.env={${Object.entries(turn.delegate.env).map(([name, envValue]) => `${toml(name)}=${toml(envValue)}`).join(',')}}`,
      '-c', 'mcp_servers.dsh-delegate.tool_timeout_sec=3600',
      '-c', 'mcp_servers.dsh-delegate.startup_timeout_sec=30',
      // The bridge validates profiles; child actions still use DSH approvals.
      '-c', 'mcp_servers.dsh-delegate.default_tools_approval_mode="approve"',
      '-c', 'mcp_servers.dsh-delegate.supports_parallel_tool_calls=true',
      '-c', 'mcp_servers.dsh-delegate.enabled=true',
    ] : [];
    const child = spawn(cliCommand('codex-cli'), [...delegateArgs, '--disable', 'multi_agent', 'app-server', '--listen', 'stdio://'], {
      cwd: turn.cwd, env: cliEnv(turn.account), windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    let buffer = '';
    let stderr = '';
    let nextId = 1;
    let threadId = turn.sessionId;
    let turnId: string | undefined;
    let completed = false;
    const pending = new Map<number, { resolve(value: Json): void; reject(error: Error): void }>();
    const toolTitles = new Map<string, { title: string; detail?: string }>();
    const subagentText = new Map<string, string>();
    const threadToAgent = new Map<string, string>();
    const streamedThreads = new Set<string>();
    const childToolIds = new Set<string>();
    const fileChangePaths = new Map<string, string[]>();
    const reportedFileChanges = new Set<string>();
    let sandboxSetupDone: ((result: Json) => void) | undefined;
    let completeTurn!: (value: void) => void;
    let failTurn!: (error: Error) => void;
    const turnDone = new Promise<void>((resolve, reject) => { completeTurn = resolve; failTurn = reject; });
    void turnDone.catch(() => undefined);
    const send = (value: Json): void => { if (!child.killed && child.stdin.writable) child.stdin.write(JSON.stringify(value) + '\n'); };
    const request = (method: string, params: Json): Promise<Json> => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
    let clearCancellation: (() => void) | undefined;
    const forceCancel = (): void => {
      completed = true;
      sandboxSetupDone?.({ success: false, error: 'Cancelled.' });
      for (const call of pending.values()) call.reject(new Error('Cancelled.'));
      pending.clear();
      terminateProcessTree(child);
      completeTurn();
    };
    // Setup RPCs can stall too, so install cancellation before initialize.
    this.interrupt = () => {
      if (clearCancellation) return;
      clearCancellation = cancellationDeadline(forceCancel);
      if (threadId && turnId) void request('turn/interrupt', { threadId, turnId }).catch(forceCancel);
      else forceCancel();
    };
    const value = (item: Json, key: string): string | undefined => typeof item[key] === 'string' ? item[key] as string : undefined;
    const toolInfo = (item: Json): { title: string; detail?: string } | undefined => {
      const type = value(item, 'type');
      if (!type || type === 'agentMessage' || type === 'reasoning' || type === 'collabAgentToolCall' || type === 'subAgentActivity') return undefined;
      const titles: Record<string, string> = {
        commandExecution: 'Command', fileChange: 'File edit', mcpToolCall: 'MCP tool', dynamicToolCall: 'Tool',
        webSearch: 'Web search',
        imageView: 'View image', contextCompaction: 'Compact context',
      };
      const title = type === 'mcpToolCall' ? value(item, 'tool') || titles[type] : titles[type];
      if (!title) return undefined;
      const error = item.error && typeof item.error === 'object' ? value(item.error as Json, 'message') : undefined;
      const detail = error || value(item, 'command') || value(item, 'query') || value(item, 'prompt') || value(item, 'tool') || value(item, 'server');
      return { title, detail: detail?.slice(0, 500) };
    };
    const onMessage = (event: Json): void => {
      if (typeof event.id === 'number' && !event.method) {
        const call = pending.get(event.id);
        if (call) { pending.delete(event.id); if (event.error) call.reject(new Error(JSON.stringify(event.error))); else call.resolve((event.result || {}) as Json); }
        return;
      }
      const method = value(event, 'method') || '';
      if (this.cancelled && method !== 'turn/completed') return;
      const params = (event.params || {}) as Json;
      if (method === 'windowsSandbox/setupCompleted') { sandboxSetupDone?.(params); return; }
      if (typeof event.id === 'number') {
        if (method.endsWith('/requestApproval')) {
          const description = value(params, 'command') || value(params, 'reason') || value(params, 'toolName') || method;
          const fileChange = method.includes('fileChange');
          const paths = fileChange ? fileChangePaths.get(value(params, 'itemId') || '') || [] : [];
          // One approval per file so DSH can enforce each subagent's locked paths.
          const infos = paths.length ? paths.map(path => ({ tool: 'Edit', input: { file_path: path } })) : [{ tool: fileChange ? 'Edit' : 'Command', input: {} }];
          void (async () => {
            for (const info of infos) if ((turn.onApproval ? await turn.onApproval(description, info) : false) !== true) return false;
            return true;
          })().then(approved => {
            send({ id: event.id, result: { decision: approved ? 'accept' : 'decline' } });
          }, () => send({ id: event.id, result: { decision: 'decline' } }));
        } else send({ id: event.id, error: { code: -32601, message: 'Unsupported request' } });
        return;
      }
      if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
        const sourceThread = value(params, 'threadId');
        if (sourceThread && sourceThread !== threadId) {
          streamedThreads.add(sourceThread);
          turn.onSubagent?.({ id: threadToAgent.get(sourceThread) || sourceThread, model: turn.backend, text: params.delta, messageId: value(params, 'itemId') || 'message' });
        }
        else turn.onText(params.delta);
      }
      if (method === 'item/started' || method === 'item/completed' || method === 'item/updated') {
        const item = params.item as Json | undefined;
        if (item) {
          const id = value(item, 'id') || value(item, 'type') || 'tool';
          const type = value(item, 'type');
          const fromMainThread = !value(params, 'threadId') || value(params, 'threadId') === threadId;
          if (method === 'item/started' && type === 'agentMessage' && fromMainThread) turn.onMessageBreak?.();
          if (type === 'fileChange' && fromMainThread && Array.isArray(item.changes)) {
            const paths = item.changes.map(change => change && typeof change === 'object' ? value(change as Json, 'path') : undefined).filter((path): path is string => !!path);
            if (paths.length) fileChangePaths.set(id, paths);
            if (paths.length && method === 'item/completed' && value(item, 'status') === 'completed' && !reportedFileChanges.has(id)) {
              reportedFileChanges.add(id);
              turn.onFileChange?.(paths);
            }
          }
          if (type === 'collabAgentToolCall') {
            const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((value): value is string => typeof value === 'string') : [];
            const states = item.agentsStates && typeof item.agentsStates === 'object' ? item.agentsStates as Json : {};
            for (const receiver of receivers) {
              threadToAgent.set(receiver, receiver);
              const state = states[receiver] && typeof states[receiver] === 'object' ? states[receiver] as Json : {};
              const rawText = streamedThreads.has(receiver) ? '' : value(state, 'message') || '';
              const key = `${id}:${receiver}`;
              const previousText = subagentText.get(key) || '';
              const text = rawText.startsWith(previousText) ? rawText.slice(previousText.length) : rawText === previousText ? '' : rawText;
              if (rawText) subagentText.set(key, rawText);
              turn.onSubagent?.({ id: receiver, title: (value(item, 'prompt') || 'Subagent').slice(0, 80),
                model: value(item, 'model') || turn.backend, prompt: value(item, 'prompt'),
                state: ['errored', 'failed', 'interrupted'].includes(value(state, 'status') || '') ? 'error'
                  : ['completed', 'shutdown'].includes(value(state, 'status') || '') ? 'complete' : 'running',
                ...(text ? { text, messageId: `result:${id}` } : {}) });
            }
          } else if (type === 'subAgentActivity') {
            const agentId = value(item, 'agentThreadId') || id;
            const alreadyKnown = threadToAgent.has(agentId);
            threadToAgent.set(agentId, agentId);
            const kind = value(item, 'kind');
            turn.onSubagent?.({ id: agentId, title: alreadyKnown ? undefined : value(item, 'agentPath') || 'Subagent', model: turn.backend,
              state: kind === 'completed' ? 'complete' : kind === 'interrupted' ? 'error' : 'running' });
          }
          const info = toolInfo(item) || toolTitles.get(id);
          const sourceThread = value(params, 'threadId');
          if (sourceThread && sourceThread !== threadId) {
            if (info && !childToolIds.has(id)) {
              childToolIds.add(id);
              turn.onSubagent?.({ id: threadToAgent.get(sourceThread) || sourceThread, role: 'tool',
                text: `${info.title}${info.detail ? `: ${info.detail}` : ''}`, messageId: `tool:${id}` });
            }
            return;
          }
          if (info) {
            toolTitles.set(id, info);
            const status = value(item, 'status');
            turn.onTool(id, info.title, info.detail, status === 'failed' ? 'error' : method === 'item/completed' ? 'complete' : 'running');
          }
        }
      }
      if (method === 'turn/completed') {
        const item = params.turn as Json | undefined;
        if (!turnId || item?.id === turnId) {
          completed = true;
          const status = item && value(item, 'status');
          if (status === 'failed' && !this.cancelled) failTurn(new Error('Codex turn failed. Check the selected account and model.'));
          else completeTurn();
        }
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 10_000_000) { child.kill(); failTurn(new Error('Codex stream exceeded the size limit.')); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (!line) continue;
        try { onMessage(JSON.parse(line) as Json); } catch { /* Ignore non-protocol output. */ }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => { failTurn(new Error(`Codex app-server could not start: ${error.message}`)); });
    child.on('close', code => {
      for (const call of pending.values()) call.reject(new Error(`Codex app-server exited with code ${code}. ${stderr}`));
      pending.clear();
      if (!completed) { if (this.cancelled) completeTurn(); else failTurn(new Error(`Codex app-server exited with code ${code}. ${stderr}`)); }
    });
    try {
      await request('initialize', { clientInfo: { name: 'dsh-ide', title: 'DSH IDE', version: '0.4.3' }, capabilities: null });
      send({ method: 'initialized' });
      if (this.cancelled) return threadId;
      const full = turn.fullAccess && !turn.readOnly;
      // A fresh Codex home on Windows has no sandbox, and Codex silently runs everything read-only until it is set up.
      const sandboxHome = turn.account.directory;
      if (process.platform === 'win32' && !turn.readOnly && !full && !windowsSandboxReady.has(sandboxHome)) {
        const readiness = await request('windowsSandbox/readiness', {}).catch(() => undefined);
        if (readiness && value(readiness, 'status') !== 'ready') {
          const finished = new Promise<Json>(resolve => { sandboxSetupDone = resolve; });
          const timer = setTimeout(() => sandboxSetupDone?.({ success: false, error: 'Timed out after 120 seconds.' }), 120_000);
          try {
            await request('windowsSandbox/setupStart', { mode: 'unelevated', cwd: turn.cwd });
            const result = await finished;
            if (!this.cancelled && result.success !== true) throw new Error(`Codex could not set up its Windows sandbox, so edits would be read-only: ${value(result, 'error') || 'unknown error'}`);
          } finally { clearTimeout(timer); sandboxSetupDone = undefined; }
        }
        if (this.cancelled) return threadId;
        windowsSandboxReady.add(sandboxHome);
      }
      const approvalPolicy = full ? 'never' : 'on-request';
      const sandbox = turn.readOnly ? 'read-only' : full ? 'danger-full-access' : 'workspace-write';
      // Override persisted thread/project settings on resume as well as start.
      const delegation = { developerInstructions: delegationInstructions(!!turn.delegate), config: {
        'features.multi_agent': false,
        ...(turn.delegate ? { 'mcp_servers.dsh-delegate.default_tools_approval_mode': 'approve', 'mcp_servers.dsh-delegate.enabled': true, 'mcp_servers.dsh-delegate.supports_parallel_tool_calls': true } : {}),
      } };
      const start = threadId
        ? await request('thread/resume', { threadId, cwd: turn.cwd, approvalPolicy, sandbox, ...delegation })
        : await request('thread/start', { cwd: turn.cwd, approvalPolicy, sandbox, ...delegation, ...(turn.backend === 'default' ? {} : { model: turn.backend }) });
      const thread = start.thread as Json | undefined;
      threadId = value(thread || {}, 'id') || threadId;
      if (!threadId) throw new Error('Codex did not return a thread ID.');
      if (this.cancelled) return threadId;
      const input = [{ type: 'text', text: turn.prompt, text_elements: [] }, ...(turn.images || []).map(image => ({ type: 'localImage', path: image.path }))];
      const serviceTierForTurn = codexServiceTier(turn.speed);
      const response = await request('turn/start', { threadId, input, cwd: turn.cwd, approvalPolicy,
        ...(turn.readOnly ? { sandboxPolicy: { type: 'readOnly' } } : full ? { sandboxPolicy: { type: 'dangerFullAccess' } } : {}),
        ...(turn.backend === 'default' ? {} : { model: turn.backend }), ...(turn.effort ? { effort: turn.effort } : {}),
        ...(serviceTierForTurn ? { serviceTierForTurn } : {}) });
      turnId = value((response.turn || {}) as Json, 'id');
      if (this.cancelled) this.interrupt();
      await turnDone;
      return threadId;
    } finally {
      clearCancellation?.();
      this.interrupt = undefined;
      this.child = undefined;
      terminateProcessTree(child);
    }
  }
}
