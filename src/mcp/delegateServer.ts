import { createInterface } from 'node:readline';

const url = process.env.DSH_DELEGATE_URL || '';
const token = process.env.DSH_DELEGATE_TOKEN || '';
const owner = process.env.DSH_DELEGATE_OWNER || '';

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
  try {
    const described = await post('/describe', {});
    const list = Array.isArray(described.agents) ? described.agents as { name: string; description?: string; mode: string; model: string }[] : [];
    agents = list.map(agent => `- ${agent.name} (${agent.mode}, model ${agent.model})${agent.description ? `: ${agent.description}` : ''}`).join('\n');
    custom = Array.isArray(described.tools) ? described.tools as Json[] : [];
  } catch { /* the host may be unavailable; fall back to a generic description */ }
  return [
    {
      name: 'list_subagents',
      description: 'List the only subagents available in DSH, with their exact profile names and mode (read-only or edit). Use these names with delegate_task.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'delegate_task',
      description: `Run a task on a subagent (possibly a different model or provider) and wait for its final answer. Subagents see the same working copy.\nAvailable subagents:\n${agents || '(none configured)'}\nOmit "files" or pass an empty list to run any profile as read-only. Read-only subagents cannot modify files. For edit-capable profiles, a non-empty "files" list enables edits only to those paths. Those paths are locked to that subagent until it finishes, so neither you nor other subagents can edit them meanwhile. Use a trailing "/" to lock a whole directory.`,
      // Claude Code only runs MCP tools concurrently when they are marked read-only. Edit subagents are still confined to their locked paths.
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Exact configured profile name from list_subagents; not a model name or a native agent role.' },
          task: { type: 'string', description: 'Complete, self-contained instructions for the subagent.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Optional paths (relative to the working copy) an edit-capable subagent may edit. Omit or pass an empty list to run read-only.' },
        },
        required: ['agent', 'task'],
      },
    },
    {
      name: 'ask_questions',
      description: 'Ask the user focused multiple-choice questions in the DSH chat and wait for their answers. Use it when a decision belongs to the user and you cannot resolve it from the request or the code. Each question is single choice; the user can always answer with their own text instead. Ask 1 to 4 questions per call, keep them specific, and put your recommended option first.',
      inputSchema: {
        type: 'object',
        properties: {
          questions: {
            type: 'array', minItems: 1, maxItems: 4,
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: 'The complete question, ending with a question mark.' },
                header: { type: 'string', description: 'Very short label (max 12 characters).' },
                options: {
                  type: 'array', minItems: 2, maxItems: 4,
                  items: { type: 'object', properties: { label: { type: 'string', description: 'Concise choice text (1-5 words).' }, description: { type: 'string', description: 'What choosing this means.' } }, required: ['label'] },
                  description: 'Do not include an "Other" option; the user can always type their own answer.',
                },
              },
              required: ['question', 'options'],
            },
          },
        },
        required: ['questions'],
      },
    },
    ...custom.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    {
      name: 'list_locked_files',
      description: 'List files currently locked by running subagents. Do not edit these until the subagent finishes.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
      reply(id, { protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'dsh-delegate', version: '1.0.0' }, instructions: 'delegate_task is the DSH subagent command and replaces native subagent tools. Only configured profiles returned by list_subagents are available. Use their exact names; do not spawn native agents or substitute other models. ask_questions asks the user multiple-choice questions in the DSH chat. Other tools on this server come from custom toolpacks the user installed.' });
    } else if (method === 'ping') reply(id, {});
    else if (method === 'tools/list') reply(id, { tools: await tools() });
    else if (method === 'tools/call') {
      const params = (message.params || {}) as Json;
      const result = await post('/call', { tool: params.name, args: params.arguments || {} });
      reply(id, { content: [{ type: 'text', text: String(result.text ?? result.error ?? '') }], isError: result.isError === true || !!result.error });
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
