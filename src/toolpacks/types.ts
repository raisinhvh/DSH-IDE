export interface ToolpackContext {
    log(message: string): void;
    /** One short line shown on the pack's card in the Custom Tool Calls tab. */
    status(text: string): void;
    /** Directory this pack may use to persist files between runs. */
    dataDir: string;
}

export type ToolpackContent =
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' };

export interface ToolpackResult { text: string; content?: ToolpackContent[]; isError?: boolean }

export interface ToolpackTool {
    name: string;
    description: string;
    /** JSON Schema object describing the arguments. Defaults to no arguments. */
    inputSchema?: Record<string, unknown>;
    /** Strings/JSON are supported, or return { content: [text/image blocks], isError? } for MCP images. */
    run(args: Record<string, unknown>, ctx: ToolpackContext): unknown | Promise<unknown>;
}

/** Settings files in the pack's dataDir that Config Sync carries to other PCs. */
export interface ToolpackSync {
    /** JSON object files directly in dataDir, e.g. `config.json`. */
    files: string[];
    /** Top-level keys that stay on each PC and are never uploaded. Keys that look like keys, tokens or passwords are always kept local. */
    secrets?: string[];
}

/** What an uploaded .ts file must `export default`. */
export interface ToolpackDefinition {
    /** Lowercase id (a-z, 0-9, _). Agents see tools as `<name>_<tool name>`. */
    name: string;
    description: string;
    tools: ToolpackTool[];
    sync?: ToolpackSync;
    /** Runs once when the pack starts. May open servers or connections. */
    setup?(ctx: ToolpackContext): void | Promise<void>;
    teardown?(): void | Promise<void>;
}

export interface ToolDescriptor {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

export interface ToolpackManifest {
    name: string;
    description: string;
    tools: ToolDescriptor[];
    sync?: ToolpackSync;
}

/** dataDir settings files a pack may declare: plain names, no folders. */
export const TOOLPACK_SYNC_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/;

export type HostToWorker =
    | { type: 'load'; file: string; dataDir: string }
    | { type: 'start' }
    | { type: 'call'; id: number; tool: string; args: Record<string, unknown> }
    | { type: 'stop' };

export type WorkerToHost =
    | { type: 'loaded'; manifest: ToolpackManifest }
    | { type: 'started' }
    | { type: 'failed'; error: string }
    | ({ type: 'result'; id: number } & ToolpackResult)
    | { type: 'status'; text: string }
    | { type: 'log'; text: string };

export const TOOLPACK_NAME = /^[a-z][a-z0-9_]{0,31}$/;
