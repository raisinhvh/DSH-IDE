import * as vscode from 'vscode';
import {
  getSidebarHtml,
  initialSidebarState,
  SidebarHostMessage,
  SidebarViewState,
  SidebarWebviewMessage,
  SidebarTimelineItem,
  SidebarSubagent,
} from './view';

export type SidebarMessageHandler = (message: SidebarWebviewMessage) => void | Promise<void>;

/** Host side of the DSH sidebar. Runtime integration is supplied via onMessage. */
export class DshSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'dsh.sidebar';
  private view?: vscode.WebviewView;
  private state: SidebarViewState = initialSidebarState();
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage?: SidebarMessageHandler,
    private readonly saveTimeline?: (sessionId: string, timeline: SidebarTimelineItem[], subagents: Record<string, SidebarSubagent>) => void,
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    const asset = (name: string): string => webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name)).toString();
    webviewView.webview.html = getSidebarHtml(webviewView.webview, this.state, {
      stylesheet: asset('sidebar.css'), script: asset('sidebar.js'), font: asset('MaterialSymbolsRounded.woff2'), markdown: asset('markdown-it.min.js'),
    });
    this.disposables.push(webviewView.webview.onDidReceiveMessage((message: SidebarWebviewMessage) => {
      if (!message || typeof message.type !== 'string') return;
      void this.onMessage?.(message);
    }));
    webviewView.onDidDispose(() => { this.view = undefined; });
  }

  /** Push a runtime event into the sidebar. Safe before the view has been opened. */
  public postMessage(message: SidebarHostMessage): Thenable<boolean> | undefined {
    this.reduce(message);
    const sessionId = 'sessionId' in message ? message.sessionId : undefined;
    if (sessionId) this.saveTimeline?.(sessionId, this.state.timeline[sessionId] || [], this.state.subagents[sessionId] || {});
    return this.view?.webview.postMessage(message);
  }

  public dispose(): void { this.disposables.splice(0).forEach(d => d.dispose()); }

  public hasTimeline(sessionId: string): boolean { return (this.state.timeline[sessionId]?.length || 0) > 0; }

  public timeline(sessionId: string): SidebarTimelineItem[] { return this.state.timeline[sessionId] || []; }
  public subagents(sessionId: string): Record<string, SidebarSubagent> { return this.state.subagents[sessionId] || {}; }

  public setPage(page: SidebarViewState['page']): void { this.state.page = page; }

  private reduce(message: SidebarHostMessage): void {
    switch (message.type) {
      case 'timelineState':
        this.state.timeline[message.sessionId] = message.timeline;
        this.state.subagents[message.sessionId] = message.subagents;
        this.state.messages[message.sessionId] = message.timeline.flatMap(item => item.kind === 'message' ? [{ role: item.role, text: item.text }] : []);
        if (message.sessionId === this.state.activeSessionId) this.state.tools = [];
        break;
      case 'sessionState': Object.assign(this.state, { sessions: message.sessions, activeSessionId: message.activeSessionId }); break;
      case 'sessionDeleted':
        for (const table of [this.state.timeline, this.state.messages, this.state.subagents, this.state.runStates, this.state.queues] as Record<string, unknown>[]) delete table[message.sessionId];
        break;
      case 'queueState': this.state.queues[message.sessionId] = message.items; break;
      case 'modelState': Object.assign(this.state, { models: message.models, cursorBackends: message.cursorBackends, selectedModelId: message.selectedModelId, selectedSpeed: message.selectedSpeed, selectedEffort: message.selectedEffort }); break;
      case 'accountState': Object.assign(this.state, { providerLabel: message.provider, accountLabel: message.label, accountConnected: message.connected }); break;
      case 'accountsState': Object.assign(this.state, { accounts: message.accounts, cursor: message.cursor }); break;
      case 'subagentProfilesState': this.state.subagentProfiles = message.profiles; break;
      case 'instructionsState': this.state.instructions = message.items; break;
      case 'customizeState': this.state.features = message.features; this.state.nameModel = message.nameModel; this.state.accessibility = message.accessibility; break;
      case 'syncState': this.state.sync = message.sync; break;
      case 'approvalState': this.state.approvalMode = message.mode; break;
      case 'showPage': this.state.page = message.page; break;
      case 'userMessage': {
        (this.state.messages[message.sessionId] ||= []).push({ role: 'user', text: message.text });
        (this.state.timeline[message.sessionId] ||= []).push({ id: message.entryId || `user:${Date.now()}:${Math.random()}`, kind: 'message', role: 'user', text: message.text });
        break;
      }
      case 'assistantDelta': {
        const items = this.state.messages[message.sessionId] ||= [];
        const last = items[items.length - 1];
        if (last?.role === 'assistant') last.text += message.text;
        else items.push({ role: 'assistant', text: message.text });
        const timeline = this.state.timeline[message.sessionId] ||= [];
        const id = message.entryId || `assistant:${timeline.length}`;
        const entry = timeline.find(item => item.id === id);
        if (entry?.kind === 'message') entry.text += message.text;
        else timeline.push({ id, kind: 'message', role: 'assistant', text: message.text });
        break;
      }
      case 'assistantMessage': {
        (this.state.messages[message.sessionId] ||= []).push({ role: 'assistant', text: message.text });
        (this.state.timeline[message.sessionId] ||= []).push({ id: `assistant:${Date.now()}:${Math.random()}`, kind: 'message', role: 'assistant', text: message.text });
        break;
      }
      case 'runState': {
        if (this.state.runStates[message.sessionId]?.state === 'cancelling' && message.state === 'idle') {
          if (message.sessionId === this.state.activeSessionId) this.state.tools = this.state.tools.map(tool => tool.state === 'running' ? { ...tool, state: 'cancelled' } : tool);
          for (const entry of this.state.timeline[message.sessionId] || []) if (entry.kind === 'tool' && entry.event.state === 'running') entry.event = { ...entry.event, state: 'cancelled' };
          for (const agent of Object.values(this.state.subagents[message.sessionId] || {})) if (agent.state === 'running') agent.state = 'cancelled';
        }
        this.state.runStates[message.sessionId] = { state: message.state, label: message.label };
        if (message.state === 'thinking') this.state.error = undefined;
        break;
      }
      case 'toolEvent': {
        const previous = this.state.tools.find(t => t.id === message.event.id);
        const event = { ...previous, ...message.event };
        if (event.title === 'Tool' && previous?.title) event.title = previous.title;
        if (!event.detail && previous?.detail) event.detail = previous.detail;
        this.state.tools = this.state.tools.filter(t => t.id !== event.id).concat(event);
        const sessionId = message.sessionId || this.state.activeSessionId;
        if (sessionId && event.kind !== 'edit' && event.kind !== 'subagent') {
          const timeline = this.state.timeline[sessionId] ||= [];
          const id = message.entryId || `tool:${event.id}`;
          const entry = timeline.find(item => item.id === id);
          if (entry?.kind === 'tool') entry.event = event;
          else timeline.push({ id, kind: 'tool', event });
        }
        break;
      }
      case 'subagentEvent': {
        const agents = this.state.subagents[message.sessionId] ||= {};
        const agent = agents[message.agentId] ||= { id: message.agentId, title: message.title || 'Subagent', state: 'running', messages: [] };
        if (message.title) agent.title = message.title;
        if (message.model) agent.model = message.model;
        if (message.prompt) agent.prompt = message.prompt;
        if (message.files) agent.files = message.files;
        if (message.state) agent.state = message.state;
        if (message.text) {
          const id = message.messageId || `message:${agent.messages.length}`;
          const entry = agent.messages.find(item => item.id === id);
          if (entry) entry.text += message.text;
          else agent.messages.push({ id, role: message.role || 'assistant', text: message.text });
        }
        const timeline = this.state.timeline[message.sessionId] ||= [];
        if (!timeline.some(item => item.kind === 'subagent' && item.agentId === message.agentId)) timeline.push({ id: `subagent:${message.agentId}`, kind: 'subagent', agentId: message.agentId });
        break;
      }
      case 'approvalRequest':
        (this.state.timeline[message.sessionId] ||= []).push({ id: `approval:${message.id}`, kind: 'approval', title: message.title, detail: message.detail, status: 'pending' });
        break;
      case 'approvalResolved': {
        const entry = (this.state.timeline[message.sessionId] || []).find(item => item.id === `approval:${message.id}`);
        if (entry?.kind === 'approval') entry.status = message.allowed ? 'allowed' : 'rejected';
        break;
      }
      case 'questionRequest':
        (this.state.timeline[message.sessionId] ||= []).push({ id: `question:${message.id}`, kind: 'question', questions: message.questions, status: 'pending' });
        break;
      case 'questionResolved': {
        const entry = (this.state.timeline[message.sessionId] || []).find(item => item.id === `question:${message.id}`);
        if (entry?.kind === 'question') { entry.status = message.answers ? 'answered' : 'skipped'; entry.answers = message.answers || undefined; }
        break;
      }
      case 'toolpacksState': this.state.toolpacks = message.packs; this.state.toolpackError = message.error; break;
      case 'toolState': this.state.tools = message.tools; break;
      case 'diff': this.state.diffs = this.state.diffs.filter(d => d.id !== message.diff.id).concat(message.diff); break;
      case 'diffState': this.state.diffs = message.diffs; break;
      case 'error': this.state.error = message.message; break;
      case 'dependencyState': this.state.dependencies = message.providers; break;
    }
  }

}

/** Descriptive alias for hosts that prefer the VS Code API terminology. */
export { DshSidebarProvider as WebviewViewProvider };

export { getSidebarHtml, initialSidebarState } from './view';
export type { SidebarHostMessage, SidebarWebviewMessage, SidebarViewState } from './view';
