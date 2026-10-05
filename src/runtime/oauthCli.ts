import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname } from 'node:path';
import { OAuthCliAccount, cliCommand, cliEnv } from '../accounts/oauthCli';
import { CodexAppServerRuntime } from './codexAppServer';
import { delegationInstructions, isNativeSubagentTool } from './delegation';
import { terminateProcessTree } from './cancellation';
import { claudeSpeedSettings } from './models';

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
  images?: { path: string; mimeType: string }[];
  sessionId?: string;
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

/** Runs each OAuth-backed turn in the isolated review workspace. */
export class OAuthCliRuntime {
  private child?: ChildProcessWithoutNullStreams;
  private readonly codexRuntime = new CodexAppServerRuntime();
  private cancelled = false;
  private cancelTurn?: () => void;

  cancel(): void { this.cancelled = true; this.cancelTurn?.(); this.codexRuntime.cancel(); }

  async prompt(turn: CliTurn): Promise<string | undefined> {
    if (turn.account.provider === 'codex-cli') return this.codexRuntime.prompt(turn);
    if (this.child) throw new Error('An account turn is already running.');
    this.cancelled = false;
    const codex: boolean = false;
    const effort = turn.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(turn.effort)}`] : [];
    const speedSettings = claudeSpeedSettings(turn.speed);
    const args = codex
      ? turn.sessionId
        ? ['-s', 'workspace-write', '-a', 'never', ...effort, 'exec', 'resume', '--json', '--skip-git-repo-check', '--ignore-user-config', ...(turn.backend === 'default' ? [] : ['-m', turn.backend]), turn.sessionId, '-']
        : ['-s', 'workspace-write', '-a', 'never', ...effort, 'exec', '--json', '--skip-git-repo-check', '--ignore-user-config', ...(turn.backend === 'default' ? [] : ['-m', turn.backend]), '-']
      : ['--print', ...speedSettings, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio', '--disallowedTools', 'Agent,Task', '--append-system-prompt', delegationInstructions(!!turn.delegate), ...(turn.delegate ? ['--mcp-config', JSON.stringify({ mcpServers: { 'dsh-delegate': turn.delegate } }), '--allowedTools', 'mcp__dsh-delegate'] : []), '--include-partial-messages', ...(turn.images?.length ? ['--add-dir', dirname(turn.images[0].path)] : []), '--permission-mode', 'default', ...(turn.effort ? ['--effort', turn.effort] : []), ...(turn.backend === 'default' ? [] : ['--model', turn.backend]), ...(turn.sessionId ? ['--resume', turn.sessionId] : [])];
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
      const noteSubagentText = (agent: string, message: string, text: string, append: boolean): void => {
        const messages = subagentMessages.get(agent) || new Map<string, string>();
        subagentMessages.set(agent, messages);
        messages.set(message, append ? (messages.get(message) || '') + text : text);
        subagentText.set(agent, [...messages.values()].join('\n'));
      };
      const child = spawn(cliCommand(turn.account.provider), args, {
        cwd: turn.cwd, env: cliEnv(turn.account), windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      const finish = (error?: Error): void => {
        if (done) return;
        done = true;
        this.child = undefined;
        this.cancelTurn = undefined;
        if (error) reject(error); else resolve(sessionId);
      };
      this.cancelTurn = () => { terminateProcessTree(child); finish(); };
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
          if (codex) {
            if (event.type === 'thread.started' && typeof event.thread_id === 'string') sessionId = event.thread_id;
            const item = event.item as Record<string, unknown> | undefined;
            if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') { turn.onMessageBreak?.(); emit(item.text); }
            if ((event.type === 'item.started' || event.type === 'item.completed' || event.type === 'item.updated') && item &&
              ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'collab_agent_tool_call'].includes(String(item.type))) {
              const title = item.type === 'command_execution' ? 'Command' : item.type === 'file_change' ? 'File edit'
                : item.type === 'mcp_tool_call' ? String(item.tool || 'MCP tool') : item.type === 'web_search' ? 'Web search' : 'Subagent';
              const detail = typeof item.command === 'string' ? item.command : typeof item.query === 'string' ? item.query
                : typeof item.server === 'string' ? item.server : undefined;
              turn.onTool(String(item.id || title), title, detail, item.status === 'failed' ? 'error' : event.type === 'item.completed' ? 'complete' : 'running');
            }
            if (event.type === 'turn.failed') { child.kill(); finish(new Error('Codex turn failed. Open the CLI for details.')); return; }
          } else {
            if (typeof event.session_id === 'string') sessionId = event.session_id;
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
            if (event.type === 'result') child.stdin.end();
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
            if (event.type === 'result' && event.is_error === true) { child.kill(); finish(new Error('Claude Code turn failed. Check the CLI login and model.')); return; }
            if (event.type === 'result' && !emitted && typeof event.result === 'string') emit(event.result);
          }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { errorText = (errorText + chunk).slice(-4000); });
      child.on('error', () => finish(new Error(`${codex ? 'Codex' : 'Claude Code'} CLI could not start. Check the configured path.`)));
      child.on('close', code => finish(code === 0 || this.cancelled ? undefined : new Error(`${codex ? 'Codex' : 'Claude Code'} exited with code ${code}. ${errorText.includes('not logged') ? 'Sign in again from Accounts.' : 'Open the CLI for details.'}`)));
      const text = turn.images?.length ? `${turn.prompt}\n\nAttached images (view these files):\n${turn.images.map(image => image.path).join('\n')}` : turn.prompt;
      child.stdin.on('error', () => undefined);
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
    });
  }
}
