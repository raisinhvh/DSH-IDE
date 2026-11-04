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

export const BATCH_INSTRUCTIONS = `DSH batch: ${BATCH_TOOL} runs independent calls together and returns one combined result. Prefer it whenever you would make two or more independent calls to dsh-delegate tools or reads. Inside a batch only, read_file {path, offset?, limit?}, search {pattern, path?, glob?, ignore_case?, max_results?} and list_dir {path?} read the working copy.`;

export const BATCH_TOOL_SCHEMA = {
  name: BATCH_TOOL,
  description: `Run up to ${MAX_BATCH_CALLS} independent calls in parallel; one combined result, one entry per call in order. A call may name any other dsh-delegate tool, or a batch-only file tool: read_file {path, offset? (first line, 1-based), limit? (lines, default ${DEFAULT_READ_LINES})}, search {pattern (JS regex), path?, glob? (e.g. "*.ts"), ignore_case?, max_results? (default 100)}, list_dir {path?}. Paths are relative to the working copy. Calls must not depend on each other's results.`,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      calls: {
        type: 'array', minItems: 1, maxItems: MAX_BATCH_CALLS,
        items: { type: 'object', properties: { tool: { type: 'string' }, args: { type: 'object' } }, required: ['tool'] },
      },
    },
    required: ['calls'],
  },
} as const;

export interface BatchCall { tool: string; args: Record<string, unknown> }
export interface BatchOutcome { text: string; content?: ToolpackContent[]; isError?: boolean }

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
    return { tool, args: raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {} };
  });
}

/** Short label for a call, used in the result headers, the sidebar and the transcript. */
export function callLabel(call: BatchCall): string {
  const { args } = call;
  const first = ['path', 'pattern', 'agent', 'id', 'query', 'name'].map(key => args[key]).find(value => typeof value === 'string' && value);
  const files = Array.isArray(args.files) && args.files.every(item => typeof item === 'string') ? (args.files as string[]).join(', ') : '';
  const detail = typeof first === 'string' ? first : files;
  return detail ? `${call.tool} ${detail.replace(/\s+/g, ' ').slice(0, 120)}` : call.tool;
}

/** Joins the outcomes under numbered headers and keeps the whole result within MAX_BATCH_CHARS. */
export function formatBatchResult(calls: BatchCall[], outcomes: BatchOutcome[]): { text: string; content: ToolpackContent[] } {
  const limits = fairShares(outcomes.map(item => item.text.length), MAX_BATCH_CHARS);
  const extra: ToolpackContent[] = [];
  const parts = calls.map((call, index) => {
    const outcome = outcomes[index];
    const limit = limits[index];
    const body = outcome.text.length > limit ? `${outcome.text.slice(0, limit)}\n[cut at ${limit} characters; narrow this call or run it alone]` : outcome.text;
    for (const block of outcome.content || []) if (block.type !== 'text') extra.push(block);
    return `[${index + 1}] ${callLabel(call)}${outcome.isError ? ' (error)' : ''}\n${body}`;
  });
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
