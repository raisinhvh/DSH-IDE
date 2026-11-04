import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ToolpackContent } from '../toolpacks/types';

/**
 * Advanced batching: one `batch` call on the DSH bridge runs several tool calls and returns one result.
 * Besides the bridge's own tools it offers read-only file tools that exist only inside a batch.
 */
export const BATCH_TOOL = 'batch';
export const MAX_BATCH_CALLS = 20;
export const BATCH_FILE_TOOLS = ['read_file', 'search', 'list_dir'] as const;
export type BatchFileTool = typeof BATCH_FILE_TOOLS[number];

/** Total characters a batch result may return (Claude Code cuts MCP output near 25k tokens). */
export const MAX_BATCH_CHARS = 90_000;
const MAX_FILE_BYTES = 2_000_000;
const DEFAULT_READ_LINES = 2000;
const MAX_SEARCH_FILES = 20_000;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const MAX_LIST_ENTRIES = 500;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.dsh', '.hg', '.svn', '__pycache__', '.venv', '.next', '.turbo']);

/** Runs one forEach call may expand to, and how many of them run at once. */
export const MAX_FOREACH_RUNS = 50;
const FOREACH_CONCURRENCY = 4;

export const BATCH_INSTRUCTIONS = `DSH batch: ${BATCH_TOOL} runs several calls in one go and returns one combined result. From the first step of a task, put any two or more file reads, searches or listings in one ${BATCH_TOOL} instead of separate native read, grep, glob or shell calls. Read a file natively only right before editing it (edit tools require that), and use the shell only to run commands. Do the same for two or more dsh-delegate or toolpack calls, including chains: an argument "{{1.id}}" is a field of call 1's result (the call waits for it), after:[1] only orders, and forEach:"{{1.nodes}}" runs a call once per item ({{item.id}}). Inside a batch only, read_file {path, offset?, limit?}, search {pattern, path?, glob?, ignore_case?, max_results?} and list_dir {path?} read the working copy.`;

export const BATCH_TOOL_SCHEMA = {
  name: BATCH_TOOL,
  description: `Run up to ${MAX_BATCH_CALLS} calls; one combined result, one entry per call in order. A call may name any other dsh-delegate tool (toolpack tools included), or a batch-only file tool: read_file {path, offset? (first line, 1-based), limit? (lines, default ${DEFAULT_READ_LINES})}, search {pattern (JS regex), path?, glob? (e.g. "*.ts"), ignore_case?, max_results? (default 100)}, list_dir {path?}. Paths are relative to the working copy. Calls run in parallel unless they depend on earlier ones:
- "{{N.path}}" in any argument string is part of call N's JSON result, e.g. "{{1.id}}", "{{1.nodes[0].id}}", "{{1.nodes[*].id}}" (a list). As the whole string it keeps its type; inside a longer string it becomes text. "{{N}}" is the whole result, or its text when it is not JSON.
- after: [N, ...] waits for those calls without using their results (e.g. a write, then a read).
- forEach: "{{N.path}}" runs the call once per item of that list (at most ${MAX_FOREACH_RUNS}); "{{item}}" or "{{item.id}}" is the current item.
A call only refers to calls before it. When a call it depends on fails, it is skipped. Identical calls run once.`,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  // Keep it out of Claude Code's tool search: a deferred batch loses to the native Read and Grep that are already loaded.
  _meta: { 'anthropic/alwaysLoad': true },
  inputSchema: {
    type: 'object',
    properties: {
      calls: {
        type: 'array', minItems: 1, maxItems: MAX_BATCH_CALLS,
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string' },
            args: { type: 'object' },
            after: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Earlier call numbers (1-based) to wait for.' },
            forEach: { type: 'string', description: 'A "{{N.path}}" list; the call runs once per item.' },
          },
          required: ['tool'],
        },
      },
    },
    required: ['calls'],
  },
} as const;

/** `after` and the numbers in placeholders are 1-based call numbers, as in the result headers. */
export interface BatchCall { tool: string; args: Record<string, unknown>; after?: number[]; forEach?: string }
/** `data` is a toolpack's chaining JSON; placeholders read it instead of the text when it is there. */
export interface BatchOutcome { text: string; content?: ToolpackContent[]; isError?: boolean; data?: unknown }

/** "{{2.nodes[0].id}}" is a field of call 2's result; "{{item.id}}" one of the current forEach item. */
const PLACEHOLDER = /\{\{\s*(\d+|item)((?:\.[A-Za-z_$][\w$-]*|\.\d+|\[(?:\d+|\*)\])*)\s*\}\}/g;
const WHOLE_PLACEHOLDER = new RegExp(`^\\s*${PLACEHOLDER.source}\\s*$`);

type Source = number | 'item';

/** Calls `visit` for every string inside a value and rebuilds the value from what it returns. */
function mapStrings(value: unknown, visit: (text: string) => unknown): unknown {
  if (typeof value === 'string') return visit(value);
  if (Array.isArray(value)) return value.map(item => mapStrings(item, visit));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, visit)]));
  return value;
}

function placeholderSources(value: unknown): Source[] {
  const sources: Source[] = [];
  mapStrings(value, text => {
    for (const match of text.matchAll(PLACEHOLDER)) sources.push(match[1] === 'item' ? 'item' : Number(match[1]));
    return text;
  });
  return sources;
}

/** Earlier calls a call waits for: those its placeholders read, then those named in `after`. */
export function callDependencies(call: BatchCall): number[] {
  const sources = [...placeholderSources(call.args), ...placeholderSources(call.forEach ?? ''), ...(call.after ?? [])];
  return [...new Set(sources.filter((source): source is number => source !== 'item'))].sort((a, b) => a - b);
}

/** MCP clients name a bridge tool bare or qualified with the server name. */
export function isBatchTool(tool: string): boolean {
  return /^(?:(?:mcp[._/]{1,2})?dsh[-_]delegate[._/]{1,2})?batch$/i.test(tool.trim());
}

export function isBatchFileTool(tool: string): tool is BatchFileTool {
  return (BATCH_FILE_TOOLS as readonly string[]).includes(tool);
}

export function parseBatchCalls(args: Record<string, unknown>): BatchCall[] {
  const calls = args.calls;
  if (!Array.isArray(calls) || !calls.length) throw new Error('calls must be a non-empty array of { tool, args }.');
  if (calls.length > MAX_BATCH_CALLS) throw new Error(`A batch takes at most ${MAX_BATCH_CALLS} calls.`);
  return calls.map((call, index) => {
    const item = call && typeof call === 'object' ? call as Record<string, unknown> : {};
    const tool = typeof item.tool === 'string' ? item.tool.trim().replace(/^(?:mcp[._/]{1,2})?dsh[-_]delegate[._/]{1,2}/i, '') : '';
    if (!tool) throw new Error(`Call ${index + 1} has no tool name.`);
    if (isBatchTool(tool)) throw new Error('A batch cannot contain another batch.');
    const raw = item.args ?? item.arguments;
    const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const number = index + 1;
    const earlier = (source: number, what: string): void => {
      if (!Number.isInteger(source) || source < 1 || source >= number) throw new Error(`Call ${number} ${what}, but a call can only use calls before it (1-${number - 1}).`);
    };
    const rawAfter = item.after ?? item.waitFor;
    const after = rawAfter === undefined ? [] : (Array.isArray(rawAfter) ? rawAfter : [rawAfter]).map(Number);
    for (const source of after) earlier(source, `waits for call ${source}`);
    const rawForEach = item.forEach ?? item.for_each;
    if (rawForEach !== undefined && (typeof rawForEach !== 'string' || !WHOLE_PLACEHOLDER.test(rawForEach))) throw new Error(`Call ${number}: forEach must be one placeholder such as "{{1.nodes}}".`);
    const forEach = typeof rawForEach === 'string' ? rawForEach.trim() : undefined;
    for (const source of placeholderSources(forEach ?? '')) {
      if (source === 'item') throw new Error(`Call ${number}: forEach must name an earlier call, not {{item}}.`);
      earlier(source, `loops over {{${source}}}`);
    }
    for (const source of placeholderSources(args)) {
      if (source === 'item') { if (!forEach) throw new Error(`Call ${number} uses {{item}} without forEach.`); }
      else earlier(source, `uses {{${source}}}`);
    }
    return { tool, args, ...(after.length ? { after: [...new Set(after)].sort((a, b) => a - b) } : {}), ...(forEach ? { forEach } : {}) };
  });
}

/** Stable JSON with sorted keys, so { a, b } and { b, a } compare equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** What makes two calls the same: the tool and its args, with file-tool paths written one way ("./src\\a.ts" is "src/a.ts"). */
export function callKey(call: BatchCall): string {
  const args = { ...call.args };
  if (isBatchFileTool(call.tool) && typeof args.path === 'string') {
    args.path = args.path.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '') || '.';
  }
  return `${call.tool}\n${stableJson(args)}${call.after ? `\nafter ${call.after.join(',')}` : ''}${call.forEach ? `\nforEach ${call.forEach}` : ''}`;
}

/** The same call with its references to other calls renumbered by `renumber`. */
function renumberCall(call: BatchCall, renumber: (source: number) => number): BatchCall {
  if (!callDependencies(call).length) return call;
  const rewrite = (text: string): string => text.replace(PLACEHOLDER, (all, source: string, path: string) => source === 'item' ? all : `{{${renumber(Number(source))}${path}}}`);
  return {
    tool: call.tool,
    args: mapStrings(call.args, rewrite) as Record<string, unknown>,
    ...(call.after ? { after: [...new Set(call.after.map(renumber))].sort((a, b) => a - b) } : {}),
    ...(call.forEach ? { forEach: rewrite(call.forEach) } : {}),
  };
}

/**
 * Drops repeated calls so each one runs once; `skipped` counts what was dropped.
 * Later calls that referred to a dropped call refer to the call it repeated, numbered as in the result.
 */
export function uniqueBatchCalls(calls: BatchCall[]): { calls: BatchCall[]; skipped: number } {
  const seen = new Map<string, number>();
  // newNumber[original number - 1] is that call's number among the unique calls.
  const newNumber: number[] = [];
  const unique: BatchCall[] = [];
  for (const original of calls) {
    const call = renumberCall(original, source => newNumber[source - 1]);
    const key = callKey(call);
    const repeated = seen.get(key);
    if (repeated) { newNumber.push(repeated); continue; }
    unique.push(call);
    seen.set(key, unique.length);
    newNumber.push(unique.length);
  }
  return { calls: unique, skipped: calls.length - unique.length };
}

/** A call's result as data: the tool's chaining data, its JSON, the JSON after a line of text ("Updated.\n{...}"), or only its text. */
export interface BatchValue { text: string; json?: unknown; isJson: boolean }

export function batchValue(text: string, data?: unknown): BatchValue {
  if (data !== undefined) return { text, json: data, isJson: true };
  const trimmed = text.trim();
  try { return { text, json: JSON.parse(trimmed), isJson: true }; } catch { /* look for JSON inside */ }
  const start = trimmed.search(/[[{]/);
  const end = start < 0 ? -1 : trimmed.lastIndexOf(trimmed[start] === '{' ? '}' : ']');
  if (end > start) {
    try { return { text, json: JSON.parse(trimmed.slice(start, end + 1)), isJson: true }; } catch { /* plain text */ }
  }
  return { text, isJson: false };
}

function itemValue(item: unknown): BatchValue {
  return { text: typeof item === 'string' ? item : JSON.stringify(item), json: item, isJson: true };
}

function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** Follows a path such as ".nodes[0].id" or ".nodes[*].id"; throws a message that says where it stopped and what was there. */
function followPath(value: unknown, segments: string[], name: string, trail = ''): unknown {
  if (!segments.length) return value;
  const [segment, ...rest] = segments;
  if (segment === '*') {
    if (!Array.isArray(value)) throw new Error(`${name}${trail} is not a list, so [*] can't be used. It is: ${preview(value)}`);
    return value.map((item, index) => followPath(item, rest, name, `${trail}[${index}]`));
  }
  if (Array.isArray(value)) {
    const index = /^\d+$/.test(segment) ? Number(segment) : NaN;
    if (Number.isNaN(index)) throw new Error(`${name}${trail} is a list, so it has no "${segment}"; use an index such as [0] or [*].`);
    if (index >= value.length) throw new Error(`${name}${trail} has ${value.length} item${value.length === 1 ? '' : 's'}, so [${index}] is past the end.`);
    return followPath(value[index], rest, name, `${trail}[${index}]`);
  }
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, segment)) {
    return followPath((value as Record<string, unknown>)[segment], rest, name, `${trail}.${segment}`);
  }
  const keys = value && typeof value === 'object' ? Object.keys(value) : [];
  throw new Error(`${name}${trail} has no "${segment}". ${keys.length ? `Its keys: ${keys.slice(0, 30).join(', ')}.` : `It is: ${preview(value)}`}`);
}

function readPlaceholder(source: Source, path: string, lookup: (source: Source) => BatchValue): unknown {
  const value = lookup(source);
  const name = source === 'item' ? 'item' : `call ${source}'s result`;
  if (!path) return value.isJson ? value.json : value.text;
  if (!value.isJson) throw new Error(`${name} is text, not JSON, so only {{${source}}} (the whole text) can be used. It starts: ${preview(value.text)}`);
  const segments = [...path.matchAll(/\.([^.[\]]+)|\[(\d+|\*)\]/g)].map(match => match[1] ?? match[2]);
  return followPath(value.json, segments, name);
}

/** Fills placeholders in a value. A string that is only a placeholder takes the value as is; otherwise the value is written into the text. */
export function resolvePlaceholders(value: unknown, lookup: (source: Source) => BatchValue): unknown {
  return mapStrings(value, text => {
    const whole = text.match(WHOLE_PLACEHOLDER);
    if (whole) return readPlaceholder(whole[1] === 'item' ? 'item' : Number(whole[1]), whole[2], lookup);
    return text.replace(PLACEHOLDER, (_, source: string, path: string) => {
      const found = readPlaceholder(source === 'item' ? 'item' : Number(source), path, lookup);
      return typeof found === 'string' ? found : JSON.stringify(found) ?? '';
    });
  });
}

async function runSafely(call: BatchCall, run: (call: BatchCall) => Promise<BatchOutcome>): Promise<BatchOutcome> {
  try { return await run(call); } catch (error) { return { text: error instanceof Error ? error.message : String(error), isError: true }; }
}

/** Runs `tasks` with at most `limit` at a time and returns their results in order. */
async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) { const index = next++; results[index] = await tasks[index](); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

async function runForEach(call: BatchCall, items: unknown[], lookup: (source: Source) => BatchValue, run: (call: BatchCall) => Promise<BatchOutcome>): Promise<{ outcome: BatchOutcome; value: BatchValue }> {
  if (!items.length) return { outcome: { text: `${call.forEach} is an empty list; nothing ran.` }, value: itemValue([]) };
  const outcomes = await pool(items.map(item => async (): Promise<BatchOutcome> => {
    let args: Record<string, unknown>;
    try { args = resolvePlaceholders(call.args, source => source === 'item' ? itemValue(item) : lookup(source)) as Record<string, unknown>; }
    catch (error) { return { text: error instanceof Error ? error.message : String(error), isError: true }; }
    return runSafely({ tool: call.tool, args }, run);
  }), FOREACH_CONCURRENCY);
  const failed = outcomes.filter(outcome => outcome.isError).length;
  const text = outcomes.map((outcome, index) => `(${index + 1}/${items.length})${outcome.isError ? ' error:' : ''} ${outcome.text}`).join('\n');
  const content = outcomes.flatMap(outcome => (outcome.content || []).filter(block => block.type !== 'text'));
  return {
    outcome: { text: failed ? `${text}\n[${failed} of ${items.length} failed]` : text, ...(content.length ? { content } : {}), ...(failed === items.length ? { isError: true } : {}) },
    // Later calls see one entry per item: its JSON, or its text.
    value: itemValue(outcomes.map(outcome => {
      const value = batchValue(outcome.text, outcome.data);
      return value.isJson ? value.json : value.text;
    })),
  };
}

/**
 * Runs a batch: calls without dependencies start at once; the others wait for the calls they name, then run
 * with their placeholders filled in. A call whose dependency failed is skipped. `settled` reports each call as it ends.
 */
export async function executeBatch(calls: BatchCall[], run: (call: BatchCall) => Promise<BatchOutcome>, settled?: (index: number, outcome: BatchOutcome) => void): Promise<BatchOutcome[]> {
  const results: Promise<{ outcome: BatchOutcome; value: BatchValue }>[] = [];
  const start = async (call: BatchCall): Promise<{ outcome: BatchOutcome; value: BatchValue }> => {
    const dependencies = callDependencies(call);
    // Dependencies are earlier calls, so their promises already exist.
    const done = await Promise.all(dependencies.map(number => results[number - 1]));
    const failed = dependencies.filter((_, index) => done[index].outcome.isError);
    const fail = (text: string) => ({ outcome: { text, isError: true }, value: { text, isJson: false } });
    if (failed.length) return fail(`Skipped: call ${failed.join(', ')} failed.`);
    const lookup = (source: Source): BatchValue => done[dependencies.indexOf(source as number)].value;
    try {
      if (call.forEach) {
        const items = resolvePlaceholders(call.forEach, lookup);
        if (!Array.isArray(items)) return fail(`forEach ${call.forEach} is not a list. It is: ${preview(items)}`);
        if (items.length > MAX_FOREACH_RUNS) return fail(`forEach ${call.forEach} has ${items.length} items; at most ${MAX_FOREACH_RUNS} can run. Narrow the earlier call.`);
        return await runForEach(call, items, lookup, run);
      }
      const outcome = await runSafely({ tool: call.tool, args: resolvePlaceholders(call.args, lookup) as Record<string, unknown> }, run);
      return { outcome, value: batchValue(outcome.text, outcome.data) };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  };
  for (const [index, call] of calls.entries()) {
    results.push(start(call).then(result => { settled?.(index, result.outcome); return result; }));
  }
  return (await Promise.all(results)).map(result => result.outcome);
}

/** Short label for a call, used in the result headers, the sidebar and the transcript. */
export function callLabel(call: BatchCall): string {
  const { args } = call;
  const first = ['path', 'pattern', 'agent', 'id', 'query', 'name'].map(key => args[key]).find(value => typeof value === 'string' && value);
  const files = Array.isArray(args.files) && args.files.every(item => typeof item === 'string') ? (args.files as string[]).join(', ') : '';
  const detail = typeof first === 'string' ? first : files;
  const label = detail ? `${call.tool} ${detail.replace(/\s+/g, ' ').slice(0, 120)}` : call.tool;
  return call.forEach ? `${label} for each of ${call.forEach}` : label;
}

/** Joins the outcomes under numbered headers and keeps the whole result within MAX_BATCH_CHARS. */
export function formatBatchResult(calls: BatchCall[], outcomes: BatchOutcome[], skipped = 0): { text: string; content: ToolpackContent[] } {
  const note = skipped ? `[${skipped} identical call${skipped === 1 ? '' : 's'} skipped; each call above ran once]` : '';
  const limits = fairShares(outcomes.map(item => item.text.length), MAX_BATCH_CHARS - note.length);
  const extra: ToolpackContent[] = [];
  const parts = calls.map((call, index) => {
    const outcome = outcomes[index];
    const limit = limits[index];
    const body = outcome.text.length > limit ? `${outcome.text.slice(0, limit)}\n[cut at ${limit} characters; narrow this call or run it alone]` : outcome.text;
    for (const block of outcome.content || []) if (block.type !== 'text') extra.push(block);
    return `[${index + 1}] ${callLabel(call)}${outcome.isError ? ' (error)' : ''}\n${body}`;
  });
  if (note) parts.push(note);
  return { text: parts.join('\n\n'), content: extra };
}

/** Splits a character budget so short results stay whole and the long ones share what is left equally. */
export function fairShares(sizes: number[], budget: number): number[] {
  const limits = sizes.map(() => 0);
  let left = budget;
  let open = sizes.map((_, index) => index);
  while (open.length) {
    const share = Math.floor(left / open.length);
    const small = open.filter(index => sizes[index] <= share);
    if (!small.length) { for (const index of open) limits[index] = share; break; }
    for (const index of small) { limits[index] = sizes[index]; left -= sizes[index]; }
    open = open.filter(index => sizes[index] > share);
  }
  return limits;
}

/** Resolves a working-copy path and refuses anything outside it, including through symlinks. */
export async function insidePath(cwd: string, path: unknown): Promise<string> {
  const value = typeof path === 'string' && path.trim() ? path.trim() : '.';
  const absolute = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  const rel = relative(cwd, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${value} is outside the working copy.`);
  const [root, real] = await Promise.all([realpath(cwd), realpath(absolute)]);
  const realRel = relative(root, real);
  if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw new Error(`${value} is outside the working copy.`);
  return absolute;
}

const display = (cwd: string, absolute: string): string => relative(cwd, absolute).split(sep).join('/') || '.';

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

/** A glob such as "*.ts", "src/**\/*.tsx" or "*.{js,mjs}" as a regular expression over slash paths. */
export function globPattern(glob: string): RegExp {
  let out = '';
  let depth = 0;
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    // "**/" also matches no directory at all, so "src/**/a.ts" finds src/a.ts.
    if (char === '*' && glob[index + 1] === '*') { out += glob[index + 2] === '/' ? '(?:.*/)?' : '.*'; index += glob[index + 2] === '/' ? 2 : 1; }
    else if (char === '*') out += '[^/]*';
    else if (char === '?') out += '[^/]';
    else if (char === '{') { out += '(?:'; depth += 1; }
    else if (char === '}' && depth) { out += ')'; depth -= 1; }
    else if (char === ',' && depth) out += '|';
    else out += char.replace(/[.+^$()|[\]{}\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

async function readFileTool(cwd: string, args: Record<string, unknown>): Promise<BatchOutcome> {
  const file = await insidePath(cwd, args.path);
  const info = await stat(file);
  if (info.isDirectory()) return { text: `${display(cwd, file)} is a directory; use list_dir.`, isError: true };
  if (info.size > MAX_FILE_BYTES) return { text: `${display(cwd, file)} is ${info.size} bytes; read it with offset and limit through your own tools.`, isError: true };
  const buffer = await readFile(file);
  if (looksBinary(buffer)) return { text: `${display(cwd, file)} is a binary file.`, isError: true };
  const lines = buffer.toString('utf8').split(/\r?\n/);
  const start = Math.max(1, Math.floor(Number(args.offset) || 1));
  const count = Math.max(1, Math.floor(Number(args.limit) || DEFAULT_READ_LINES));
  const picked = lines.slice(start - 1, start - 1 + count);
  const end = start + picked.length - 1;
  const range = start === 1 && end >= lines.length ? '' : ` (lines ${start}-${end} of ${lines.length})`;
  return { text: `${range ? `${range.trim()}\n` : ''}${picked.join('\n')}` };
}

async function searchTool(cwd: string, args: Record<string, unknown>): Promise<BatchOutcome> {
  const source = typeof args.pattern === 'string' ? args.pattern : '';
  if (!source) return { text: 'pattern is required.', isError: true };
  let regex: RegExp;
  try { regex = new RegExp(source, args.ignore_case === true ? 'i' : ''); } catch (error) { return { text: `Invalid pattern: ${error instanceof Error ? error.message : String(error)}`, isError: true }; }
  const glob = typeof args.glob === 'string' && args.glob.trim() ? args.glob.trim() : undefined;
  const globRegex = glob ? globPattern(glob) : undefined;
  const max = Math.max(1, Math.min(Math.floor(Number(args.max_results) || 100), 500));
  const start = await insidePath(cwd, args.path);
  const hits: string[] = [];
  let scanned = 0;
  let truncated = false;
  const visit = async (path: string): Promise<void> => {
    if (hits.length >= max || scanned >= MAX_SEARCH_FILES) { truncated = true; return; }
    const info = await lstat(path).catch(() => undefined);
    if (!info || info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      const entries = await readdir(path).catch(() => [] as string[]);
      for (const name of entries.sort()) {
        if (SKIP_DIRS.has(name)) continue;
        await visit(join(path, name));
        if (hits.length >= max) { truncated = true; return; }
      }
      return;
    }
    if (!info.isFile() || info.size > MAX_SEARCH_FILE_BYTES) return;
    const rel = display(cwd, path);
    if (globRegex && !globRegex.test(glob!.includes('/') ? rel : rel.split('/').pop()!)) return;
    scanned += 1;
    const buffer = await readFile(path).catch(() => undefined);
    if (!buffer || looksBinary(buffer)) return;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!regex.test(lines[index])) continue;
      const line = lines[index].trim();
      hits.push(`${rel}:${index + 1}: ${line.length > 200 ? `${line.slice(0, 200)}…` : line}`);
      if (hits.length >= max) { truncated = true; return; }
    }
  };
  await visit(start);
  if (!hits.length) return { text: 'No matches.' };
  return { text: `${hits.join('\n')}${truncated ? `\n[stopped at ${hits.length} matches; narrow path or glob]` : ''}` };
}

async function listDirTool(cwd: string, args: Record<string, unknown>): Promise<BatchOutcome> {
  const dir = await insidePath(cwd, args.path);
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries.map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name).sort();
  const shown = names.slice(0, MAX_LIST_ENTRIES);
  return { text: `${shown.join('\n') || '(empty)'}${names.length > shown.length ? `\n[${names.length - shown.length} more entries]` : ''}` };
}

export async function runBatchFileTool(cwd: string, tool: BatchFileTool, args: Record<string, unknown>): Promise<BatchOutcome> {
  try {
    if (tool === 'read_file') return await readFileTool(cwd, args);
    if (tool === 'search') return await searchTool(cwd, args);
    return await listDirTool(cwd, args);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return { text: code === 'ENOENT' ? `${String(args.path ?? '.')} does not exist.` : error instanceof Error ? error.message : String(error), isError: true };
  }
}
