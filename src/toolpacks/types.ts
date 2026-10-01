export interface ToolpackContext {
  log(message: string): void;
  /** One short line shown on the pack's card in the Custom Tool Calls tab. */
  status(text: string): void;
  /** Directory this pack may use to persist files between runs. */
  dataDir: string;
}

export interface ToolpackTool {
  name: string;
  description: string;
  /** JSON Schema object describing the arguments. Defaults to no arguments. */
  inputSchema?: Record<string, unknown>;
  /** Strings are returned as-is; anything else is sent as pretty-printed JSON. */
  run(args: Record<string, unknown>, ctx: ToolpackContext): unknown | Promise<unknown>;
}

/** What an uploaded .ts file must `export default`. */
export interface ToolpackDefinition {
  /** Lowercase id (a-z, 0-9, _). Agents see tools as `<name>_<tool name>`. */
  name: string;
  description: string;
  tools: ToolpackTool[];
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
}

export type HostToWorker =
  | { type: 'load'; file: string; dataDir: string }
  | { type: 'start' }
  | { type: 'call'; id: number; tool: string; args: Record<string, unknown> }
  | { type: 'stop' };

export type WorkerToHost =
  | { type: 'loaded'; manifest: ToolpackManifest }
  | { type: 'started' }
  | { type: 'failed'; error: string }
  | { type: 'result'; id: number; text: string; isError?: boolean }
  | { type: 'status'; text: string }
  | { type: 'log'; text: string };

export const TOOLPACK_NAME = /^[a-z][a-z0-9_]{0,31}$/;
