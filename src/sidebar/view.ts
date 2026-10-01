import { randomBytes } from 'node:crypto';

export interface SidebarImage { name: string; mimeType: string; data: string }
export type ApprovalMode = 'ask' | 'auto' | 'full';
export type SidebarPage = 'chat' | 'accounts' | 'models' | 'subagents' | 'instructions' | 'toolcalls';

export type SidebarWebviewMessage =
  | { type: 'ready' }
  | { type: 'pageChanged'; page: SidebarPage }
  | { type: 'sendPrompt'; prompt: string; images?: SidebarImage[]; mode?: 'interrupt' | 'queue' }
  | { type: 'unqueue'; sessionId: string; index: number }
  | { type: 'editMessage'; sessionId: string; entryId: string; text: string }
  | { type: 'readInstruction'; id: string }
  | { type: 'openInstruction'; id: string }
  | { type: 'saveInstruction'; id?: string; kind: 'rule' | 'skill'; scope: 'workspace' | 'global'; file?: string; name?: string; description?: string; content: string }
  | { type: 'removeInstruction'; id: string }
  | { type: 'setApproval'; mode: ApprovalMode }
  | { type: 'approvalResponse'; id: string; allow: boolean }
  | { type: 'questionResponse'; id: string; answers: string[] | null }
  | { type: 'pickToolpack' }
  | { type: 'toolpackAction'; id: string; action: 'enable' | 'disable' | 'reload' | 'remove' }
  | { type: 'cancel' }
  | { type: 'newSession' }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'renameSession'; sessionId: string; name: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'selectModel'; modelId: string }
  | { type: 'selectSpeed'; value: string }
  | { type: 'selectEffort'; value: string }
  | { type: 'saveModel'; originalName?: string; name: string; provider: string; backend: string; account: string; speedOptions: { label: string; backend: string }[]; effortOptions: string[] }
  | { type: 'removeModel'; name: string }
  | { type: 'saveSubagent'; originalName?: string; profile: SidebarSubagentProfile }
  | { type: 'removeSubagent'; name: string }
  | { type: 'manageAccounts' }
  | { type: 'refreshAccounts' }
  | { type: 'checkDependencies' }
  | { type: 'installProvider'; provider: string }
  | { type: 'viewProviderUsage'; provider: string }
  | { type: 'addAccount'; provider: string; label: string; email?: string; secret: string }
  | { type: 'addOAuthAccount'; provider: 'codex-cli' | 'claude-cli'; label: string; email?: string }
  | { type: 'setDefaultAccount'; provider: string; accountId: string }
  | { type: 'removeAccount'; accountId: string }
  | { type: 'cursorLogin' }
  | { type: 'cursorLogout' }
  | { type: 'openAuthUrl'; url: string }
  | { type: 'openFile'; path: string; line?: number; column?: number }
  | { type: 'openDiff'; diffId: string }
  | { type: 'applyDiff'; diffId: string }
  | { type: 'rejectDiff'; diffId: string }
  | { type: 'applyAll' }
  | { type: 'rejectAll' }
  | { type: 'reviewAll' }
  | { type: 'openTerminal' };

export interface SidebarSubagentProfile {
  name: string;
  description?: string;
  model: string;
  effort?: string;
  speed?: string;
  mode: 'read-only' | 'edit';
}

export interface SidebarInstruction {
  id: string;
  kind: 'rule' | 'skill';
  scope: 'workspace' | 'global';
  name: string;
  path: string;
  description?: string;
}

export interface SidebarToolpack {
  id: string;
  description: string;
  enabled: boolean;
  state: 'starting' | 'running' | 'stopped' | 'error';
  status: string;
  error?: string;
  tools: { name: string; description: string }[];
  logs: string[];
}

export interface SidebarQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
}

export interface SidebarSession {
  id: string;
  name: string;
  updatedAt?: number;
  messageCount?: number;
}

export interface SidebarModel {
  id: string;
  name: string;
  provider: string;
  backend: string;
  account?: string;
  enabled?: boolean;
  speedOptions?: { label: string; backend: string }[];
  effortOptions?: string[];
}

export interface SidebarAccount {
  id: string;
  provider: string;
  label: string;
  email?: string;
  isDefault: boolean;
  authType?: 'oauth' | 'api-key';
}

export interface SidebarDependency {
  provider: string;
  installed: boolean;
  installing: boolean;
  error?: string;
}

export interface CursorAccountState {
  connected: boolean;
  label: string;
  busy?: boolean;
  authUrl?: string;
  error?: string;
}

export interface SidebarToolEvent {
  id: string;
  kind: 'read' | 'search' | 'shell' | 'edit' | 'subagent' | 'other';
  title: string;
  detail?: string;
  state: 'running' | 'complete' | 'error' | 'cancelled';
}

export interface SidebarSubagent {
  id: string;
  title: string;
  model?: string;
  prompt?: string;
  files?: string[];
  state: 'running' | 'complete' | 'error' | 'cancelled';
  messages: { id: string; role: 'assistant' | 'tool'; text: string }[];
}

export interface SidebarDiff {
  id: string;
  path: string;
  summary: string;
  additions?: number;
  deletions?: number;
  state?: 'pending' | 'applied' | 'rejected';
}

export type SidebarTimelineItem =
  | { id: string; kind: 'message'; role: 'user' | 'assistant'; text: string }
  | { id: string; kind: 'tool'; event: SidebarToolEvent }
  | { id: string; kind: 'subagent'; agentId: string }
  | { id: string; kind: 'diff'; diff: SidebarDiff }
  | { id: string; kind: 'approval'; title: string; detail: string; status: 'pending' | 'allowed' | 'rejected' }
  | { id: string; kind: 'question'; questions: SidebarQuestion[]; status: 'pending' | 'answered' | 'skipped'; answers?: string[] };

export type SidebarHostMessage =
  | { type: 'timelineState'; sessionId: string; timeline: SidebarTimelineItem[]; subagents: Record<string, SidebarSubagent> }
  | { type: 'sessionState'; sessions: SidebarSession[]; activeSessionId?: string }
  | { type: 'sessionDeleted'; sessionId: string }
  | { type: 'queueState'; sessionId: string; items: string[] }
  | { type: 'modelState'; models: SidebarModel[]; cursorBackends?: { value: string; name: string }[]; selectedModelId?: string; selectedSpeed?: string; selectedEffort?: string }
  | { type: 'accountState'; provider: string; label: string; connected: boolean }
  | { type: 'accountsState'; accounts: SidebarAccount[]; cursor: CursorAccountState }
  | { type: 'accountSaved' }
  | { type: 'dependencyState'; providers: SidebarDependency[] }
  | { type: 'approvalState'; mode: ApprovalMode }
  | { type: 'approvalRequest'; sessionId: string; id: string; title: string; detail: string }
  | { type: 'approvalResolved'; sessionId: string; id: string; allowed: boolean }
  | { type: 'questionRequest'; sessionId: string; id: string; questions: SidebarQuestion[] }
  | { type: 'questionResolved'; sessionId: string; id: string; answers: string[] | null }
  | { type: 'toolpacksState'; packs: SidebarToolpack[]; error?: string }
  | { type: 'modelSaved' }
  | { type: 'modelRemoveFailed'; name: string }
  | { type: 'subagentProfilesState'; profiles: SidebarSubagentProfile[] }
  | { type: 'subagentSaved' }
  | { type: 'instructionsState'; items: SidebarInstruction[] }
  | { type: 'instructionContent'; id: string; content: string }
  | { type: 'instructionSaved' }
  | { type: 'showPage'; page: SidebarPage }
  | { type: 'assistantDelta'; sessionId: string; text: string; entryId?: string }
  | { type: 'assistantMessage'; sessionId: string; text: string; timestamp?: number }
  | { type: 'userMessage'; sessionId: string; text: string; entryId?: string }
  | { type: 'runState'; sessionId: string; state: 'idle' | 'thinking' | 'tool' | 'cancelling'; label?: string }
  | { type: 'toolEvent'; event: SidebarToolEvent; sessionId?: string; entryId?: string }
  | { type: 'toolState'; tools: SidebarToolEvent[] }
  | { type: 'subagentEvent'; sessionId: string; agentId: string; title?: string; model?: string; prompt?: string; files?: string[]; state?: SidebarSubagent['state']; text?: string; messageId?: string; role?: 'assistant' | 'tool' }
  | { type: 'diff'; diff: SidebarDiff }
  | { type: 'diffState'; diffs: SidebarDiff[] }
  | { type: 'error'; message: string };

export interface SidebarViewState {
  page: SidebarPage;
  sessions: SidebarSession[];
  activeSessionId?: string;
  models: SidebarModel[];
  selectedModelId?: string;
  selectedSpeed?: string;
  selectedEffort?: string;
  providerLabel: string;
  accountLabel: string;
  accountConnected: boolean;
  accounts: SidebarAccount[];
  dependencies: SidebarDependency[];
  cursor: CursorAccountState;
  messages: Record<string, { role: 'user' | 'assistant'; text: string }[]>;
  timeline: Record<string, SidebarTimelineItem[]>;
  tools: SidebarToolEvent[];
  subagents: Record<string, Record<string, SidebarSubagent>>;
  diffs: SidebarDiff[];
  runStates: Record<string, { state: 'idle' | 'thinking' | 'tool' | 'cancelling'; label?: string }>;
  queues: Record<string, string[]>;
  approvalMode: ApprovalMode;
  subagentProfiles: SidebarSubagentProfile[];
  instructions: SidebarInstruction[];
  toolpacks: SidebarToolpack[];
  toolpackError?: string;
  error?: string;
}

export const initialSidebarState = (): SidebarViewState => ({
  page: 'chat', approvalMode: 'ask', subagentProfiles: [], instructions: [], toolpacks: [], sessions: [], models: [], providerLabel: 'No provider', accountLabel: 'No account connected',
  accountConnected: false, accounts: [], dependencies: [], cursor: { connected: false, label: 'Not connected' },
  messages: {}, timeline: {}, tools: [], subagents: {}, diffs: [], runStates: {}, queues: {},
});

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface SidebarAssets { stylesheet: string; script: string; font: string; markdown?: string }

export function getSidebarHtml(
  webview: { cspSource: string },
  state: SidebarViewState = initialSidebarState(),
  assets: SidebarAssets = { stylesheet: 'vscode-resource:/media/sidebar.css', script: 'vscode-resource:/media/sidebar.js', font: 'vscode-resource:/media/MaterialSymbolsRounded.woff2' },
): string {
  const nonce = randomBytes(24).toString('base64');
  const boot = JSON.stringify(state).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:; font-src ${webview.cspSource};">
<style nonce="${nonce}">@font-face{font-family:'Material Symbols Rounded';font-style:normal;font-weight:100 700;src:url('${escapeHtml(assets.font)}') format('woff2')}</style>
<link rel="stylesheet" href="${escapeHtml(assets.stylesheet)}">
<title>DeepSeek Harness</title></head><body>
<header class="topbar">
  <div class="brand" id="view-title">Chats</div>
  <div class="top-actions">
    <button class="icon-button" id="instructions" type="button" title="Rules and skills" aria-label="Rules and skills"><span class="symbol">menu_book</span></button>
    <button class="icon-button" id="models" type="button" title="Add or manage models" aria-label="Add or manage models"><span class="symbol">tune</span></button>
    <button class="icon-button" id="subagents" type="button" title="Configure subagents" aria-label="Configure subagents"><span class="symbol">groups</span></button>
    <button class="icon-button" id="toolcalls" type="button" title="Custom tool calls" aria-label="Custom tool calls"><span class="symbol">extension</span></button>
    <button class="icon-button" id="new" type="button" title="Start a new chat" aria-label="Start a new chat"><span class="symbol">add_comment</span></button>
    <button class="icon-button" id="accounts" type="button" title="Manage signed-in accounts" aria-label="Manage signed-in accounts"><span class="symbol">account_circle</span></button>
  </div>
</header>
<div id="notice" class="notice" role="status" hidden></div>
<section id="chat-page" class="page chat-page">
  <div class="chat-tabs"><div id="sessions" class="session-list" aria-label="Open chats"></div><div class="recent-wrap"><button id="recent-toggle" class="recent-toggle" type="button" title="Browse all recent chats" aria-label="Browse all recent chats" aria-expanded="false">Recent <span class="symbol small">expand_more</span></button><div id="recent-menu" class="recent-menu" hidden></div></div></div>
  <main id="feed" class="feed" aria-live="polite"></main>
  <div id="status" class="run-status"></div>
  <div id="queue" class="queue-list" aria-label="Queued messages" hidden></div>
  <section id="changes" class="changes" aria-label="File changes" hidden><div class="changes-head"><button id="changes-toggle" class="changes-toggle" type="button" aria-expanded="false"><span class="symbol small" id="changes-icon">expand_less</span><span id="changes-label">Changes</span><span id="changes-total" class="change-counts"></span></button><div id="changes-bulk" class="changes-bulk" hidden><button id="reject-all" class="change-action" type="button" title="Reject all pending changes">Reject all</button><button id="apply-all" class="change-action change-apply" type="button" title="Apply all pending changes">Apply all</button></div></div><div id="changes-body" class="changes-body"><div id="changes-list" class="changes-list"></div></div></section>
  <form id="composer" class="composer"><div id="attachments" class="attachments" hidden></div><div id="composer-input" class="composer-input"><button class="icon-button" id="attach" type="button" title="Upload files for context" aria-label="Upload files for context"><span class="symbol">add</span></button><textarea id="prompt" aria-label="Message" placeholder="Ask about your workspace or request an edit"></textarea></div><div class="composer-options"><div class="model-picker-wrap"><button id="model-picker" class="composer-choice" type="button" aria-label="Choose model" aria-haspopup="listbox" aria-controls="model-menu" aria-expanded="false"><span id="model-picker-label">Choose model</span><span class="symbol small">expand_more</span></button><div id="model-menu" class="model-menu" role="listbox" hidden></div></div><div id="speed-control" class="option-wrap" hidden><button id="speed-picker" class="composer-choice" type="button" title="Choose response speed" aria-expanded="false"><span id="speed-label">Speed</span><span class="symbol small">expand_more</span></button><div id="speed-options" class="option-menu" hidden></div></div><div id="effort-control" class="option-wrap" hidden><button id="effort-picker" class="composer-choice" type="button" title="Choose reasoning effort" aria-expanded="false"><span id="effort-label">Effort</span><span class="symbol small">expand_more</span></button><div id="effort-options" class="option-menu" hidden></div></div></div><div id="compose-actions" class="compose-actions"><div id="compose-tools" class="compose-tools"><button class="tool-button" id="approval" type="button" aria-pressed="false" title="Ask before running tools" aria-label="Ask before running tools"><span class="symbol small" id="approval-icon">shield</span><span id="approval-label">Ask approval</span></button></div><div id="compose-send" class="compose-send"><button class="text-button cancel-run" type="button" id="cancel" title="Cancel task" aria-label="Cancel task" hidden><span class="symbol small">stop_circle</span><span class="cancel-label">Cancel task</span></button><div class="send-wrap"><button class="primary-button" type="submit" id="send" aria-haspopup="menu" aria-expanded="false"><span class="symbol small" id="send-icon">arrow_upward</span><span id="send-label">Send</span><span class="symbol small send-chevron" id="send-chevron" hidden>expand_less</span></button><div id="send-menu" class="send-menu" role="menu" aria-label="Send while a task is running" hidden><button type="button" class="send-option" role="menuitem" data-mode="interrupt"><span class="symbol send-option-icon">bolt</span><span class="send-option-copy"><span class="send-option-title">Interrupt</span><span class="send-option-desc">Stop the current task and send now</span></span></button><button type="button" class="send-option" role="menuitem" data-mode="queue"><span class="symbol send-option-icon">schedule_send</span><span class="send-option-copy"><span class="send-option-title">Queue message</span><span class="send-option-desc">Send automatically when the task finishes</span></span></button></div></div></div></div><input id="image-input" type="file" multiple hidden></form>
</section>
<section id="accounts-page" class="page settings-page" hidden>
  <div class="page-heading"><button class="icon-button back" data-page="chat" title="Back to chat" aria-label="Back to chat"><span class="symbol">arrow_back</span></button><div><h1>Accounts</h1></div></div>
  <div id="account-groups" class="scroll-content"></div>
  <form id="account-form" class="inline-form" hidden>
    <h2 id="account-form-title">Add account</h2><p id="account-form-help" class="helper"></p>
    <label>Account name<input id="account-name" maxlength="80" autocomplete="off" required placeholder="Personal or work"></label>
    <label>Email <span class="optional">optional</span><input id="account-email" type="email" autocomplete="off" placeholder="name@example.com"></label>
    <label id="account-key-field">API key<input id="account-key" type="password" autocomplete="off" required placeholder="Paste an API key"></label>
    <div class="form-actions"><button type="button" class="text-button" id="account-cancel">Cancel</button><button type="submit" class="primary-button" id="account-submit">Save account</button></div>
  </form>
</section>
<section id="models-page" class="page settings-page" hidden>
  <div class="page-heading"><button class="icon-button back" data-page="chat" title="Back to chat" aria-label="Back to chat"><span class="symbol">arrow_back</span></button><div><h1>Models</h1></div></div>
  <div class="settings-toolbar"><button id="add-model" class="secondary-button" type="button"><span class="symbol small">add</span> Add model</button></div>
  <div id="model-list" class="scroll-content"></div>
  <form id="model-form" class="inline-form" hidden>
    <h2 id="model-form-title">Add model</h2>
    <label>Name<input id="model-name" maxlength="80" required placeholder="My model"></label>
    <label>Provider<select id="model-provider" required><option value="">Select a provider</option><option value="codex-cli">Codex (ChatGPT)</option><option value="claude-cli">Claude Code</option><option value="cursor-acp">Cursor</option><option value="deepseek-official">DeepSeek</option><option value="openrouter">OpenRouter</option></select></label>
    <label id="model-backend-field">Model ID<input id="model-backend" placeholder="Provider model ID"></label>
    <label id="model-cursor-field" hidden>Cursor model<select id="model-cursor-backend"></select></label>
    <label>Account<select id="model-account"></select></label>
    <label>Speed options<input id="model-speed-options" placeholder="Choose a provider first"></label>
    <p id="model-speed-help" class="helper">The base model is None. Each speed choice routes to the model ID you enter.</p>
    <label>Effort choices<input id="model-effort-options" placeholder="low, medium, high, xhigh"></label>
    <p id="model-form-help" class="helper"></p>
    <div class="form-actions"><button type="button" class="text-button" id="model-cancel">Cancel</button><button type="submit" class="primary-button">Save model</button></div>
  </form>
</section>
<section id="subagents-page" class="page settings-page" hidden>
  <div class="page-heading"><button class="icon-button back" data-page="chat" title="Back to chat" aria-label="Back to chat"><span class="symbol">arrow_back</span></button><div><h1>Subagents</h1></div></div>
  <p class="helper">Subagents let your main chat hand tasks to another model, even from a different provider.</p>
  <div class="settings-toolbar"><button id="add-subagent" class="secondary-button" type="button"><span class="symbol small">add</span> Add subagent</button></div>
  <div id="subagent-list" class="scroll-content"></div>
  <form id="subagent-form" class="inline-form" hidden>
    <h2 id="subagent-form-title">Add subagent</h2>
    <label>Name<input id="subagent-name" maxlength="60" required placeholder="luna-low"></label>
    <label>When to use <span class="optional">optional</span><input id="subagent-description" maxlength="200" placeholder="Cheap reviewer for quick checks"></label>
    <label>Model<select id="subagent-model" required></select></label>
    <label>Effort<select id="subagent-effort"></select></label>
    <label>Speed<select id="subagent-speed"></select></label>
    <label>Mode<select id="subagent-mode"><option value="read-only">Read-only</option><option value="edit">Can edit files (locked paths)</option></select></label>
    <div class="form-actions"><button type="button" class="text-button" id="subagent-cancel">Cancel</button><button type="submit" class="primary-button">Save subagent</button></div>
  </form>
</section>
<section id="instructions-page" class="page settings-page" hidden>
  <div class="page-heading"><button class="icon-button back" data-page="chat" title="Back to chat" aria-label="Back to chat"><span class="symbol">arrow_back</span></button><div><h1>Rules &amp; Skills</h1></div></div>
  <p class="helper">Rules are standing instructions the agent always follows. Skills are reusable playbooks it loads when they match the task.</p>
  <div class="settings-toolbar toolbar-pair"><button id="add-rule" class="secondary-button" type="button"><span class="symbol small">add</span> Add rule</button><button id="add-skill" class="secondary-button" type="button"><span class="symbol small">add</span> Add skill</button></div>
  <div id="instruction-list" class="scroll-content"></div>
  <form id="instruction-form" class="inline-form" hidden>
    <h2 id="instruction-form-title">Add rule</h2>
    <label id="instruction-scope-field">Where<select id="instruction-scope"><option value="workspace">This workspace</option><option value="global">All workspaces</option></select></label>
    <label id="instruction-file-field">File<select id="instruction-file"></select></label>
    <label id="instruction-name-field">Name<input id="instruction-name" maxlength="64" autocomplete="off" placeholder="my-skill"></label>
    <label id="instruction-description-field">When to use <span class="optional">optional</span><input id="instruction-description" maxlength="200" autocomplete="off" placeholder="Use when reviewing database migrations"></label>
    <label><span id="instruction-content-label">Instructions</span><textarea id="instruction-content" class="instruction-content" spellcheck="false" placeholder="Write the instructions here"></textarea></label>
    <div class="form-actions"><button type="button" class="text-button" id="instruction-cancel">Cancel</button><button type="submit" class="primary-button">Save</button></div>
  </form>
</section>
<section id="toolcalls-page" class="page settings-page" hidden>
  <div class="page-heading"><button class="icon-button back" data-page="chat" title="Back to chat" aria-label="Back to chat"><span class="symbol">arrow_back</span></button><div><h1>Custom Tool Calls</h1></div></div>
  <p class="helper">Toolpacks are TypeScript scripts that give the agent extra tools. Upload a .ts file to add one.</p>
  <div class="settings-toolbar"><button id="add-toolpack" class="secondary-button" type="button"><span class="symbol small">upload_file</span> Upload toolpack</button></div>
  <div id="toolpack-error" class="notice toolpack-error" role="status" hidden></div>
  <div id="toolpack-list" class="scroll-content"></div>
</section>
<script nonce="${nonce}" type="application/json" id="boot-state">${boot}</script>
<script nonce="${nonce}" src="${escapeHtml(assets.markdown || assets.script.replace(/sidebar\.js$/, 'markdown-it.min.js'))}"></script>
<script nonce="${nonce}" src="${escapeHtml(assets.script)}"></script>
</body></html>`;
}
