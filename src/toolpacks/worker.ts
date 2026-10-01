import { HostToWorker, TOOLPACK_NAME, ToolpackContext, ToolpackDefinition, ToolpackManifest, WorkerToHost } from './types';
import { normalizeToolpackResult } from './result';

const send = (message: WorkerToHost): void => { process.send?.(message); };

let pack: ToolpackDefinition | undefined;
let context: ToolpackContext | undefined;

function validate(value: unknown): ToolpackDefinition {
    const mod = value as { default?: unknown } | undefined;
    const candidate = (mod && typeof mod === 'object' && 'default' in mod ? mod.default : undefined) as Partial<ToolpackDefinition> | undefined;
    if (!candidate || typeof candidate !== 'object') throw new Error('The script must `export default` a toolpack object.');
    if (typeof candidate.name !== 'string' || !TOOLPACK_NAME.test(candidate.name)) throw new Error('Toolpack "name" must be lowercase letters, digits or _ and start with a letter.');
    if (typeof candidate.description !== 'string' || !candidate.description.trim()) throw new Error('Toolpack "description" is required.');
    if (!Array.isArray(candidate.tools) || !candidate.tools.length) throw new Error('Toolpack "tools" must be a non-empty array.');
    const seen = new Set<string>();
    for (const tool of candidate.tools) {
        if (!tool || typeof tool.name !== 'string' || !TOOLPACK_NAME.test(tool.name)) throw new Error('Every tool needs a lowercase "name".');
        if (seen.has(tool.name)) throw new Error(`Duplicate tool name "${tool.name}".`);
        seen.add(tool.name);
        if (typeof tool.description !== 'string' || !tool.description.trim()) throw new Error(`Tool "${tool.name}" needs a description.`);
        if (typeof tool.run !== 'function') throw new Error(`Tool "${tool.name}" needs a run function.`);
    }
    return candidate as ToolpackDefinition;
}

function manifest(definition: ToolpackDefinition): ToolpackManifest {
    return {
        name: definition.name,
        description: definition.description,
        tools: definition.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema ?? { type: 'object', properties: {} } })),
    };
}

async function handle(message: HostToWorker): Promise<void> {
    try {
        if (message.type === 'load') {
            context = {
                dataDir: message.dataDir,
                log: line => send({ type: 'log', text: String(line) }),
                status: line => send({ type: 'status', text: String(line) }),
            };
            pack = validate(require(message.file));
            send({ type: 'loaded', manifest: manifest(pack) });
        } else if (message.type === 'start') {
            if (!pack || !context) throw new Error('Toolpack is not loaded.');
            await pack.setup?.(context);
            send({ type: 'started' });
        } else if (message.type === 'call') {
            const tool = pack?.tools.find(item => item.name === message.tool);
            if (!pack || !context || !tool) { send({ type: 'result', id: message.id, text: `Unknown tool "${message.tool}".`, isError: true }); return; }
            try { send({ type: 'result', id: message.id, ...normalizeToolpackResult(await tool.run(message.args, context)) }); }
            catch (error) { send({ type: 'result', id: message.id, text: error instanceof Error ? error.message : String(error), isError: true }); }
        } else if (message.type === 'stop') {
            try { await pack?.teardown?.(); } finally { process.exit(0); }
        }
    } catch (error) {
        send({ type: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
}

process.on('message', (message: HostToWorker) => { void handle(message); });
process.on('uncaughtException', error => send({ type: 'log', text: `Uncaught error: ${error instanceof Error ? error.stack || error.message : String(error)}` }));
process.on('unhandledRejection', reason => send({ type: 'log', text: `Unhandled rejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}` }));
process.on('disconnect', () => process.exit(0));
