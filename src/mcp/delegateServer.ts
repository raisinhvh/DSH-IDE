import { createInterface } from 'node:readline';
import { CANCEL_SUBAGENT, TOOLPACK_SCOPE, WAIT_SUBAGENTS } from '../runtime/delegation';
import { normalizeToolpackResult } from '../toolpacks/result';
import { LOAD_TOOLPACK } from '../toolpacks/access';
import { CHAT_HISTORY_TOOL } from '../runtime/handoff';
import { BATCH_TOOL_SCHEMA } from '../runtime/batch';

const url = process.env.DSH_DELEGATE_URL || '';
const token = process.env.DSH_DELEGATE_TOKEN || '';
const owner = process.env.DSH_DELEGATE_OWNER || '';
const toolpacksOnly = process.env.DSH_DELEGATE_SCOPE === TOOLPACK_SCOPE;

type Json = Record<string, unknown>;

async function post(path: string, body: Json): Promise<Json> {
    const response = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-token': token }, body: JSON.stringify({ owner, ...body }) });
    return await response.json() as Json;
}

const reply = (id: unknown, result: Json): void => { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); };
const fail = (id: unknown, code: number, message: string): void => { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); };

async function tools(): Promise<Json[]> {
    let agents = '';
    let custom: Json[] = [];
    let batching = false;
    try {
        const described = await post('/describe', {});
        const list = Array.isArray(described.agents) ? described.agents as { name: string; description?: string; mode: string; model: string }[] : [];
        agents = list.sort((a, b) => a.name.localeCompare(b.name)).map(agent => `- ${agent.name} (${agent.mode}, ${agent.model})${agent.description ? `: ${agent.description}` : ''}`).join('\n');
        custom = Array.isArray(described.tools) ? described.tools as Json[] : [];
        batching = described.batching === true;
    } catch { /* the host may be unavailable; fall back to a generic description */ }
    const customTools = custom.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, ...(tool._meta ? { _meta: tool._meta } : {}) }));
    if (toolpacksOnly) return customTools;
    const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
    return [
        ...(batching ? [BATCH_TOOL_SCHEMA as unknown as Json] : []),
        {
            name: 'list_subagents',
            description: 'List subagent profiles (exact name, mode, model) for delegate_task.',
            annotations: readOnly,
            inputSchema: { type: 'object', properties: {} },
        },
        {
            name: 'delegate_task',
            description: `Run a task on a configured subagent (possibly another model) in the same working copy. Waits for its answer unless background is true. Without files it is read-only; files lets an edit profile change only those paths (trailing "/" for a folder), locked to it until it finishes.\nProfiles:\n${agents || '(none configured)'}`,
            // Claude Code only runs MCP tools concurrently when they are marked read-only. Edit subagents are still confined to their locked paths.
            annotations: readOnly,
            // Keep it out of Claude Code's tool search: deferred, its params stay hidden and the first call guesses them ("subagent" for agent).
            _meta: { 'anthropic/alwaysLoad': true },
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string', description: 'Exact profile name.' },
                    task: { type: 'string', description: 'Complete, self-contained instructions.' },
                    files: { type: 'array', items: { type: 'string' }, description: 'Paths an edit profile may change.' },
                    background: { type: 'boolean', description: `Return a task id at once; collect with ${WAIT_SUBAGENTS}.` },
                    after_turn: { type: 'string', enum: ['resume', 'hold', 'cancel'], description: 'Background only, if your turn ends first: resume (default) sends results in a new turn, hold attaches them to the user\'s next message, cancel stops it.' },
                },
                required: ['agent', 'task'],
            },
        },
        {
            name: WAIT_SUBAGENTS,
            description: 'Wait for background subagents and return their reports (each only once).',
            annotations: readOnly,
            // Loaded with delegate_task, so a background task can always be collected.
            _meta: { 'anthropic/alwaysLoad': true },
            inputSchema: {
                type: 'object',
                properties: {
                    ids: { type: 'array', items: { type: 'string' }, description: 'Default: all of this chat\'s.' },
                    any: { type: 'boolean', description: 'Return when the first finishes.' },
                    timeout_seconds: { type: 'integer', minimum: 0, maximum: 3000, description: 'Default 1800; 0 only checks status.' },
                },
            },
        },
        {
            name: CANCEL_SUBAGENT,
            description: 'Stop a background subagent and return what it did so far.',
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
            inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        },
        {
            name: 'ask_questions',
            description: 'Ask the user 1-4 multiple-choice questions in the chat and wait for the answers. Only for decisions that are theirs. Put your recommended option first; the user can always type their own answer, so add no "Other".',
            inputSchema: {
                type: 'object',
                properties: {
                    questions: {
                        type: 'array', minItems: 1, maxItems: 4,
                        items: {
                            type: 'object',
                            properties: {
                                question: { type: 'string' },
                                header: { type: 'string', description: 'Max 12 characters.' },
                                options: {
                                    type: 'array', minItems: 2, maxItems: 4,
                                    items: { type: 'object', properties: { label: { type: 'string', description: '1-5 words.' }, description: { type: 'string' } }, required: ['label'] },
                                },
                                multiSelect: { type: 'boolean', description: 'Answers are joined with ", ".' },
                            },
                            required: ['question', 'options'],
                        },
                    },
                },
                required: ['questions'],
            },
        },
        ...customTools,
        {
            name: 'checkpoint',
            description: `Call when a subtask is done and most earlier context is no longer needed. The summary is for you: goal, decisions, files changed, open items. The next message starts a fresh session from it; older messages stay in ${CHAT_HISTORY_TOOL}.`,
            inputSchema: { type: 'object', properties: { summary: { type: 'string' }, keep_files: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } }, required: ['summary', 'reason'] },
        },
        {
            name: CHAT_HISTORY_TOOL,
            description: 'Earlier messages of this chat word for word, with the tools each turn used, most recent last.',
            annotations: readOnly,
            inputSchema: { type: 'object', properties: {
                count: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 10.' },
                query: { type: 'string', description: 'Only messages containing all these words.' },
            } },
        },
        {
            name: 'list_locked_files',
            description: 'Files locked by running subagents; do not edit them.',
            annotations: readOnly,
            inputSchema: { type: 'object', properties: {} },
        },
    ];
}

async function handle(message: Json): Promise<void> {
    const { id, method } = message;
    if (id === undefined) return;
    try {
        if (method === 'initialize') {
            const params = (message.params || {}) as Json;
            reply(id, { protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'dsh-delegate', version: '1.0.0' }, instructions: toolpacksOnly
                ? 'Tools from toolpacks the user installed, for external apps (for example Blender or Roblox Studio) you cannot see through files.'
                : 'DSH IDE tools. Subagents run only through delegate_task. Other tools come from toolpacks the user installed.' });
        } else if (method === 'ping') reply(id, {});
        else if (method === 'tools/list') reply(id, { tools: await tools() });
        else if (method === 'tools/call') {
            const params = (message.params || {}) as Json;
            const result = await post('/call', { tool: params.name, args: params.arguments || {} });
            const content = result.content === undefined
                ? [{ type: 'text', text: String(result.text ?? result.error ?? '') }]
                : normalizeToolpackResult(result).content;
            const isError = result.isError === true || !!result.error;
            reply(id, { content, isError });
            // Loaded pack tools join the tool list; clients that follow list changes can call them directly.
            if (params.name === LOAD_TOOLPACK && !isError && result.skipListChanged !== true) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n');
        } else fail(id, -32601, `Method not found: ${String(method)}`);
    } catch (error) {
        reply(id, { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
    }
}

createInterface({ input: process.stdin }).on('line', line => {
    let message: Json;
    try { message = JSON.parse(line) as Json; } catch { return; }
    void handle(message);
});
