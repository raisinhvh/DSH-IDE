import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname } from 'node:path';
import { OAuthCliAccount, cliCommand, cliEnv } from '../accounts/oauthCli';
import { CodexAppServerRuntime } from './codexAppServer';
import { canDelegate, delegationInstructions, isNativeSubagentTool } from './delegation';
import { terminateProcessTree } from './cancellation';
import { claudeSpeedSettings } from './models';
import { isLimitNotice, isUsageLimitText, UsageLimitError } from './limits';
import { agentEnv } from './agentShell';
import { applyAgentPriority } from './priority';

export interface CliTurn {
  account: OAuthCliAccount;
  cwd: string;
  backend: string;
  effort?: string;
  speed?: string;
  fullAccess?: boolean;
  readOnly?: boolean;
  delegate?: { command: string; args: string[]; env: Record<string, string> };
  prompt: string;
  /** Fixed instructions sent as system (Claude) or developer (Codex) text on every run, instead of the default delegation note. */
  system?: string;
  images?: { path: string; mimeType: string }[];
  sessionId?: string;
  /** A one-shot helper call: no Claude Code system prompt, tools, MCP servers, rules or session. Claude only. */
  lean?: boolean;
  /** Prompt cache lifetime for this run. Lean turns default to 5m, since a one-shot never reads its cache back. Claude only. */
  cacheTtl?: '5m' | '1h';
  /** Reports Claude rate limit updates. */
  onRateLimit?: (info: unknown) => void;
  /** Drop built-in Claude and Codex tools that cannot work inside DSH or that DSH replaces (TRIMMED_CLAUDE_TOOLS, Codex goals). */
  trimTools?: boolean;
  /** Reports token usage once per Claude result event. Errors thrown here are ignored. */
  onUsage?(usage: TurnUsage): void;
  /** Prompt size of each main-conversation request as it is made (input + cached). Errors thrown here are ignored. */
  onContext?(tokens: number): void;
  /**
   * Claude answered but keeps the turn open for background tasks it started (their results may continue the turn).
   * Called with the tasks' descriptions when that wait starts, and with an empty list when Claude resumes. Errors thrown here are ignored.
   */
  onBackgroundWait?(tasks: string[]): void;
  /** Reports the tool names Claude Code loaded for this run (its system init event). Errors thrown here are ignored. */
  onInit?(info: { tools: string[]; model?: string }): void;
  onText(text: string): void;
  /** The model started a new message; text after this must not be joined to earlier text. */
  onMessageBreak?(): void;
  onTool(id: string, title: string, detail: string | undefined, state: 'running' | 'complete' | 'error'): void;
  onSubagent?(event: { id: string; title?: string; model?: string; prompt?: string; state?: 'running' | 'complete' | 'error'; text?: string; messageId?: string; role?: 'assistant' | 'tool' }): void;
  onApproval?(description: string, info?: { tool: string; input: Record<string, unknown>; autoAllowEdits?: boolean }): Promise<boolean | string>;
  /** Shows Claude's AskUserQuestion in the chat. Resolves to answers keyed by question text, or a message explaining why there are none. */
  onQuestions?(input: Record<string, unknown>): Promise<Record<string, string> | string>;
  /** Files the agent finished editing, reported even when the sandbox allowed the write without an approval. */
  onFileChange?(paths: string[]): void;
}

/** Token counts of one Claude request or turn. */
export interface TokenUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Part of cacheWrite stored for one hour. */
  cacheWrite1h: number;
  /** Part of cacheWrite stored for five minutes. */
  cacheWrite5m: number;
  output: number;
}

export interface TurnUsage {
  /** The whole turn, summed by Claude Code over all of its requests. */
  total: TokenUsage;
  /** Prompt size of the turn's last main-conversation request (input + cache read + cache write): the context the next turn starts from. */
  context?: number;
}

/** Native subagents, which DSH replaces with delegate_task. Always off. */
export const NATIVE_AGENT_TOOLS = ['Agent', 'Task'];

/**
 * Claude Code tools that cannot work inside DSH or that DSH replaces. Removing them takes their definitions out of
 * every request; names a Claude Code version does not have are ignored.
 */
export const TRIMMED_CLAUDE_TOOLS = [
  // Native multi-agent work; DSH runs subagents through delegate_task.
  'Workflow', 'SendMessage', 'ListAgents',
  // Prompts scheduled into the session later; the claude process exits after every DSH turn, so they never fire.
  'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList',
  // Worktrees would move work out of the working copy DSH reviews.
  'EnterWorktree', 'ExitWorktree',
  // Cards and pages that only claude.ai shows; DSH's chat cannot display them (it has send_media for files).
  'SendUserFile', 'ReportFindings', 'ShowOnboardingRolePicker', 'ReadNotifications', 'Artifact', 'ArtifactComments', 'ArtifactData', 'DesignSync',
  'SuggestConnectors', 'SuggestPluginInstall', 'SuggestSkills',
];

/** System text for lean one-shots, which replaces Claude Code's whole system prompt. */
export const LEAN_SYSTEM = 'Reply with only what the request asks for. Do not use tools.';

/** Reads a Claude `usage` object; undefined when it has no token counts. */
export function parseUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = raw as Record<string, unknown>;
  const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
  if (typeof usage.input_tokens !== 'number' && typeof usage.cache_read_input_tokens !== 'number') return undefined;
  const creation = (usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : {}) as Record<string, unknown>;
  return {
    input: count(usage.input_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
    cacheWrite1h: count(creation.ephemeral_1h_input_tokens),
    cacheWrite5m: count(creation.ephemeral_5m_input_tokens),
    output: count(usage.output_tokens),
  };
}

/** Command-line arguments for one Claude Code turn. */
export function claudeArgs(turn: CliTurn): string[] {
  const model = turn.backend === 'default' ? [] : ['--model', turn.backend];
  const effort = turn.effort ? ['--effort', turn.effort] : [];
  if (turn.lean) {
    // --safe-mode skips CLAUDE.md, memory, skills, hooks, plugins and MCP servers but keeps the subscription login (--bare would need an API key).
    return [
      '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--safe-mode',
      '--system-prompt', turn.system ?? LEAN_SYSTEM,
      '--tools', '',
      '--no-session-persistence',
      ...model,
      ...effort,
    ];
  }
  const bridge = turn.delegate ? ['--mcp-config', JSON.stringify({ mcpServers: { 'dsh-delegate': turn.delegate } }), '--allowedTools', 'mcp__dsh-delegate'] : [];
  return [
    '--print', ...claudeSpeedSettings(turn.speed),
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-prompt-tool', 'stdio',
    '--disallowedTools', [...NATIVE_AGENT_TOOLS, ...(turn.trimTools ? TRIMMED_CLAUDE_TOOLS : [])].join(','),
    '--append-system-prompt', turn.system ?? delegationInstructions(canDelegate(turn.delegate)),
    ...bridge,
    '--include-partial-messages',
    ...(turn.images?.length ? ['--add-dir', dirname(turn.images[0].path)] : []),
    '--permission-mode', 'default',
    ...effort,
    ...model,
    ...(turn.sessionId ? ['--resume', turn.sessionId] : []),
  ];
}

/**
 * How long Claude Code must stay idle, with nothing left to run, before its input is closed. A queued message or a
 * finished background task turns it back to running within this time.
 */
export const IDLE_CLOSE_MS = 1_500;

/**
 * Longest wait on background tasks DSH tracks before closing input anyway. Claude Code stops a background command
 * after at most 2 hours, so a real task ends before this; the limit only covers a task whose end was never reported.
 */
export const BACKGROUND_WAIT_LIMIT_MS = 130 * 60_000;

/** Claude Code that reports session state, after a result, has not gone idle within this time: input is closed anyway so the turn cannot hang. */
export const NO_IDLE_LIMIT_MS = 10 * 60_000;

/** Child environment for a Claude turn, with the prompt cache lifetime when the turn sets one. */
function claudeEnv(turn: CliTurn): NodeJS.ProcessEnv {
  const ttl = turn.cacheTtl ?? (turn.lean ? '5m' : undefined);
  // Session state events (idle / running / requires_action) tell DSH when closing stdin can no longer cut off a permission request.
  const env = { ...agentEnv(cliEnv(turn.account)), CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' };
  return ttl ? { ...env, CLAUDE_CODE_PROMPT_CACHE_TTL: ttl } : env;
}

/** Runs one Claude Code turn as `claude --print` with stream-json input and output. */
export class ClaudeCliRuntime {
  private child?: ChildProcessWithoutNullStreams;
  private cancelled = false;
  private cancelTurn?: () => void;
  private sayTurn?: (text: string) => boolean;

  cancel(): void { this.cancelled = true; this.cancelTurn?.(); }

  /** Adds a user message to the running turn; Claude Code reads it before its next request. False when no turn is running. */
  say(text: string): boolean { return this.sayTurn?.(text) ?? false; }

  async prompt(turn: CliTurn): Promise<string | undefined> {
    if (this.child) throw new Error('An account turn is already running.');
    this.cancelled = false;
    const args = claudeArgs(turn);
    return new Promise<string | undefined>((resolve, reject) => {
      let buffer = '';
      let errorText = '';
      let sessionId = turn.sessionId;
      let done = false;
      let emitted = '';
      const currentClaudeMessages = new Map<string, string>();
      const streamedClaudeMessages = new Set<string>();
      const toolNames = new Map<string, string>();
      const subagentTools = new Set<string>();
      const subagentText = new Map<string, string>();
      const subagentMessages = new Map<string, Map<string, string>>();
      // Claude asks permission over stdin, and once stdin has ended every request fails with "Stream closed".
      // It can keep working after a result: background tasks finish and continue the turn, and a resumed session
      // can report a result before it reads the new message. So stdin stays open until Claude reports it is idle
      // with no background task left (older CLIs without session state: until the result, or 5 s of quiet).
      // Background task id → description.
      const backgroundTasks = new Map<string, string>();
      let turnOver = false;
      let waitingForTasks = false;
      let idleTimer: NodeJS.Timeout | undefined;
      // Latest session_state_changed state; undefined while this CLI has reported none.
      let sessionState: string | undefined;
      const reportWait = (tasks: string[]): void => {
        try { turn.onBackgroundWait?.(tasks); } catch { /* Callback errors must not interrupt the turn. */ }
      };
      // A background task that never ends (a dev server, a watcher) keeps Claude alive after its input closes,
      // so the turn would wait forever. Past a grace period the process tree, task included, is stopped.
      let exitTimer: NodeJS.Timeout | undefined;
      let stoppedLingering = false;
      const endInput = (): void => {
        clearTimeout(idleTimer);
        if (!child.stdin.writableEnded) child.stdin.end();
        if (!exitTimer) exitTimer = setTimeout(() => {
          if (done || child.exitCode !== null || !turnOver) return;
          stoppedLingering = true;
          terminateProcessTree(child);
        }, 15_000);
        exitTimer.unref();
      };
      const settleInput = (): void => {
        clearTimeout(idleTimer);
        if (!turnOver || child.stdin.writableEnded) return;
        const wait = backgroundTasks.size ? BACKGROUND_WAIT_LIMIT_MS
          : sessionState === undefined ? 5_000
          : sessionState === 'idle' ? IDLE_CLOSE_MS : NO_IDLE_LIMIT_MS;
        idleTimer = setTimeout(endInput, wait);
      };
      const noteSubagentText = (agent: string, message: string, text: string, append: boolean): void => {
        const messages = subagentMessages.get(agent) || new Map<string, string>();
        subagentMessages.set(agent, messages);
        messages.set(message, append ? (messages.get(message) || '') + text : text);
        subagentText.set(agent, [...messages.values()].join('\n'));
      };
      let contextTokens: number | undefined;
      let lastContextRequest = '';
      const child = spawn(cliCommand(turn.account.provider), args, {
        cwd: turn.cwd, env: claudeEnv(turn), windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      applyAgentPriority(child.pid);
      const finish = (error?: Error): void => {
        if (done) return;
        done = true;
        clearTimeout(idleTimer);
        this.child = undefined;
        this.cancelTurn = undefined;
        this.sayTurn = undefined;
        if (error) reject(error); else resolve(sessionId);
      };
      this.cancelTurn = () => { terminateProcessTree(child); finish(); };
      this.sayTurn = text => {
        if (done || this.cancelled || turnOver || child.stdin.writableEnded || child.stdin.destroyed) return false;
        child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
        return true;
      };
      const emit = (value: string): void => {
        if (!value) return;
        if (value.startsWith(emitted)) { turn.onText(value.slice(emitted.length)); emitted = value; }
        else { turn.onText(value); emitted += value; }
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (done || this.cancelled) return;
        buffer += chunk;
        if (buffer.length > 10_000_000) { child.kill(); finish(new Error('CLI output exceeded the size limit.')); return; }
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
          if (!line) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          if (event.type === 'rate_limit_event') {
            try { turn.onRateLimit?.(event.rate_limit_info); } catch { /* Callback errors must not interrupt the turn. */ }
            continue;
          }
          if (typeof event.session_id === 'string') sessionId = event.session_id;
          if (event.type === 'system' && event.subtype === 'init' && Array.isArray(event.tools)) {
            const tools = event.tools.filter((tool): tool is string => typeof tool === 'string');
            try { turn.onInit?.({ tools, model: typeof event.model === 'string' ? event.model : undefined }); } catch { /* Callback errors must not interrupt the turn. */ }
          }
          if (event.type === 'system' && typeof event.task_id === 'string') {
            const status = event.subtype === 'task_updated' ? (event.patch as Record<string, unknown> | undefined)?.status : event.status;
            if (event.subtype === 'task_started') {
              backgroundTasks.set(event.task_id, typeof event.description === 'string' ? event.description : 'Background task');
            } else if (event.subtype === 'task_notification' || (event.subtype === 'task_updated' && typeof status === 'string')) {
              if (status !== 'running' && status !== 'pending') backgroundTasks.delete(event.task_id);
            }
          }
          // The full list of running tasks, so a task whose end was reported some other way is not waited on forever.
          if (event.type === 'system' && event.subtype === 'background_tasks_changed' && Array.isArray(event.tasks)) {
            const running = new Set<string>();
            for (const task of event.tasks) {
              if (!task || typeof task !== 'object') continue;
              const { task_id: id, description } = task as Record<string, unknown>;
              if (typeof id !== 'string') continue;
              running.add(id);
              if (!backgroundTasks.has(id)) backgroundTasks.set(id, typeof description === 'string' ? description : 'Background task');
            }
            for (const id of [...backgroundTasks.keys()]) if (!running.has(id)) backgroundTasks.delete(id);
            if (waitingForTasks && backgroundTasks.size) reportWait([...backgroundTasks.values()]);
          }
          const stateChange = event.type === 'system' && event.subtype === 'session_state_changed' && typeof event.state === 'string' ? event.state : undefined;
          if (stateChange) sessionState = stateChange;
          if (event.type === 'assistant' || event.type === 'stream_event' || event.type === 'control_request' || (stateChange && stateChange !== 'idle')) {
            turnOver = false;
            if (waitingForTasks) {
              waitingForTasks = false;
              reportWait([]);
            }
          }
          if (event.type === 'result') {
            turnOver = true;
            // A CLI that reports session state is closed once it goes idle (settleInput); an older one right away.
            if (!backgroundTasks.size) { if (sessionState === undefined) endInput(); }
            else {
              waitingForTasks = true;
              reportWait([...backgroundTasks.values()]);
            }
          }
          settleInput();
          if (event.type === 'control_request') {
            const request = (event.request || {}) as Record<string, unknown>;
            const requestId = String(event.request_id || '');
            const respond = (response: Record<string, unknown>): void => {
              if (!done && !this.cancelled && !child.stdin.destroyed) child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }) + '\n');
            };
            if (request.subtype === 'can_use_tool') {
              if (isNativeSubagentTool(String(request.tool_name || ''))) {
                respond({ behavior: 'deny', message: 'Use DSH delegate_task with a configured subagent profile.' });
                continue;
              }
              const input = (request.input && typeof request.input === 'object' ? request.input : {}) as Record<string, unknown>;
              // In print mode AskUserQuestion only gets answers through the permission callback; approving it plainly returns none.
              if (request.tool_name === 'AskUserQuestion') {
                void (turn.onQuestions ? turn.onQuestions(input) : Promise.resolve('Asking the user is not available here. Continue with your best judgement.')).then(
                  answers => respond(typeof answers === 'string' ? { behavior: 'deny', message: answers } : { behavior: 'allow', updatedInput: { ...input, answers } }),
                  () => respond({ behavior: 'deny', message: 'Could not show the questions to the user.' }));
                continue;
              }
              const description = `${String(request.tool_name || 'Tool')}: ${typeof input.command === 'string' ? input.command : JSON.stringify(input).slice(0, 1500)}`;
              const info = { tool: String(request.tool_name || ''), input, autoAllowEdits: true };
              void (turn.onApproval ? turn.onApproval(description, info) : Promise.resolve(false)).then(
                allowed => respond(allowed === true ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: typeof allowed === 'string' ? allowed : 'The user rejected this action.' }),
                () => respond({ behavior: 'deny', message: 'Approval failed.' }));
            } else if (requestId) {
              child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'Unsupported request' } }) + '\n');
            }
            continue;
          }
          if (event.type === 'stream_event') {
            const stream = event.event as Record<string, unknown> | undefined;
            const delta = stream?.delta as Record<string, unknown> | undefined;
            const parentToolId = String(event.parent_tool_use_id || stream?.parent_tool_use_id || '');
            const source = parentToolId || 'root';
            if (stream?.type === 'message_start') {
              currentClaudeMessages.set(source, String((stream.message as Record<string, unknown> | undefined)?.id || ''));
              if (!parentToolId) turn.onMessageBreak?.();
            }
            if (stream?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
              const messageId = currentClaudeMessages.get(source) || 'stream';
              if (parentToolId) { noteSubagentText(parentToolId, messageId, delta.text, true); turn.onSubagent?.({ id: parentToolId, text: delta.text, messageId }); }
              else { turn.onText(delta.text); emitted += delta.text; }
              if (messageId !== 'stream') streamedClaudeMessages.add(messageId);
            }
          }
          if (event.type === 'assistant') {
            const message = event.message as Record<string, unknown> | undefined;
            const blocks = Array.isArray(message?.content) ? message.content as Record<string, unknown>[] : [];
            const parentToolId = String(event.parent_tool_use_id || message?.parent_tool_use_id || '');
            const requestUsage = parentToolId ? undefined : parseUsage(message?.usage);
            if (requestUsage) {
              contextTokens = requestUsage.input + requestUsage.cacheRead + requestUsage.cacheWrite;
              // Claude Code repeats a request's usage on each of its content events; report each request once.
              const requestId = String(message?.id || '');
              if (requestId !== lastContextRequest) { lastContextRequest = requestId; try { turn.onContext?.(contextTokens); } catch { /* ignored */ } }
            }
            for (const block of blocks) {
              if (block.type === 'text' && typeof block.text === 'string' && !streamedClaudeMessages.has(String(message?.id || ''))) {
                if (parentToolId) { noteSubagentText(parentToolId, String(message?.id || 'message'), block.text, false); turn.onSubagent?.({ id: parentToolId, text: block.text, messageId: String(message?.id || 'message') }); }
                else { turn.onText(block.text); emitted += block.text; }
              }
              if (block.type === 'tool_use') {
                const id = String(block.id || block.name || 'claude-tool');
                const title = String(block.name || 'Claude tool');
                toolNames.set(id, title);
                const input = block.input && typeof block.input === 'object' ? block.input as Record<string, unknown> : {};
                if (/^(Agent|Task)$/i.test(title)) {
                  subagentTools.add(id);
                  turn.onSubagent?.({ id, title: String(input.description || input.name || 'Subagent'), prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
                    model: typeof input.model === 'string' ? input.model : turn.backend, state: 'running' });
                } else if (parentToolId) turn.onSubagent?.({ id: parentToolId, text: `${title}${Object.keys(input).length ? `: ${JSON.stringify(input).slice(0, 500)}` : ''}`, messageId: `tool:${id}`, role: 'tool' });
                else turn.onTool(id, title, block.input && typeof block.input === 'object' ? JSON.stringify(block.input).slice(0, 500) : undefined, 'running');
              }
            }
          }
          if (event.type === 'user') {
            const message = event.message as Record<string, unknown> | undefined;
            const blocks = Array.isArray(message?.content) ? message.content as Record<string, unknown>[] : [];
            const parentToolId = String(event.parent_tool_use_id || message?.parent_tool_use_id || '');
            for (const block of blocks) if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
              if (subagentTools.has(block.tool_use_id)) {
                const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content)
                  ? (block.content as Record<string, unknown>[]).filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n') : undefined;
                const cleaned = text?.replace(/\n*agentId: [\s\S]*$/, '').trim();
                const seen = subagentText.get(block.tool_use_id) || '';
                const duplicate = !cleaned || seen.includes(cleaned);
                turn.onSubagent?.({ id: block.tool_use_id, state: block.is_error ? 'error' : 'complete', ...(duplicate ? {} : { text: cleaned, messageId: 'result' }) });
              } else if (!parentToolId) turn.onTool(block.tool_use_id, toolNames.get(block.tool_use_id) || 'Claude tool', undefined, block.is_error ? 'error' : 'complete');
            }
          }
          if (event.type === 'result') {
            const total = parseUsage(event.usage);
            if (total) {
              try { turn.onUsage?.({ total, context: contextTokens }); } catch { /* Callback errors must not interrupt the turn. */ }
            }
            const result = typeof event.result === 'string' ? event.result.trim() : '';
            // A spent plan comes back as a result whose only text is the limit notice.
            if (result && (event.is_error === true ? isUsageLimitText(result) : isLimitNotice(result))) {
              child.kill(); finish(new UsageLimitError(`Claude Code usage limit: ${result.slice(0, 300)}`)); return;
            }
            if (event.is_error === true) { child.kill(); finish(new Error(`Claude Code turn failed.${result ? ` ${result.slice(0, 300)}` : ''} Check the CLI login and model.`)); return; }
          }
          if (event.type === 'result' && !emitted && typeof event.result === 'string') emit(event.result);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { errorText = (errorText + chunk).slice(-4000); });
      child.on('error', () => finish(new Error('Claude Code CLI could not start. Check the configured path.')));
      const closed = (code: number | null): void => finish(code === 0 || this.cancelled || stoppedLingering ? undefined : isUsageLimitText(errorText)
        ? new UsageLimitError(`Claude Code usage limit: ${errorText.trim().slice(-300)}`)
        : new Error(`Claude Code exited with code ${code}. ${errorText.includes('not logged') ? 'Sign in again from Accounts.' : 'Open the CLI for details.'}`));
      child.on('close', closed);
      // 'close' waits for every holder of the output pipes; a process Claude left behind can hold them open, so the exit alone ends the turn soon after.
      child.on('exit', code => { setTimeout(() => closed(code), 3_000).unref(); });
      const text = turn.images?.length ? `${turn.prompt}\n\nAttached images (view these files):\n${turn.images.map(image => image.path).join('\n')}` : turn.prompt;
      child.stdin.on('error', () => undefined);
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
    });
  }
}

/** Runs each OAuth-backed turn in the isolated review workspace: Codex turns on the app server, Claude turns on the Claude Code CLI. */
export class OAuthCliRuntime extends ClaudeCliRuntime {
  private readonly codexRuntime = new CodexAppServerRuntime();

  override cancel(): void { super.cancel(); this.codexRuntime.cancel(); }

  override say(text: string): boolean { return super.say(text) || this.codexRuntime.say(text); }

  override prompt(turn: CliTurn): Promise<string | undefined> {
    return turn.account.provider === 'codex-cli' ? this.codexRuntime.prompt(turn) : super.prompt(turn);
  }
}
