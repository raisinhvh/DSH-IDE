import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

/** A model-written summary of one file, valid while the file's text still hashes to `hash`. */
export interface FileSummary { hash: string; summary: string; updatedAt: number }

export interface SummaryOptions {
  /** JSON file holding this workspace's summaries. */
  file: string;
  /** Runs a summary prompt on the summary model in `cwd` and returns the reply. */
  generate(cwd: string, prompt: string): Promise<string>;
  /** False while the feature is off or no summary model is set. */
  enabled(): boolean;
  log(line: string): void;
  /** Workspace-relative paths that never get summaries. */
  excluded?(path: string): boolean;
}

export const SUMMARY_TOOL = {
  name: 'read_file_summaries',
  description: 'Read short summaries of workspace files (purpose and bare function, class and type definitions) instead of whole files. Pass paths relative to the working copy. For a file, a missing or out-of-date summary is written before the reply, which can take a few seconds. A folder (or ".") gives a brief overview: its subfolders, and each file directly in it with the first line of its summary; files never summarized show only their name. Read the file itself when you need exact code, and before editing it.',
  inputSchema: {
    type: 'object',
    properties: { paths: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Files or folders, relative to the working copy.' } },
    required: ['paths'],
  },
};

export const SUMMARY_INSTRUCTIONS = 'DSH file summaries: read_file_summaries on the dsh-delegate MCP server returns short summaries of workspace files (purpose and bare definitions). Summaries are your primary way to learn the codebase. IMPORTANT: always call read_file_summaries before reading any file, and pass several files in one call. A folder path gives only a brief one-line-per-file overview of what is directly in it; ask for the files themselves to get full summaries. Read a whole file only when it is absolutely necessary: when you are about to edit it, or when you need exact code the summary does not give. Do not read files just to explore or to understand what they do; find candidate files with search tools and check their summaries instead. Never read the same file twice unless it has changed since you read it.';

const MAX_FILE_CHARS = 150_000;
const BATCH_CHARS = 120_000;
const BATCH_FILES = 8;
const MAX_SUMMARY_CHARS = 6000;
const MAX_LOOKUP_CHARS = 80_000;
const MAX_FOLDER_ENTRIES = 300;

export const hashText = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Forward-slash path relative to `cwd`, or undefined when the path is outside it. */
export function normalizePath(cwd: string, raw: string): string | undefined {
  const rel = (isAbsolute(raw) ? relative(cwd, raw) : raw).replaceAll('\\', '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return undefined;
  return rel;
}

/** The file a read tool opened, from a tool title and its JSON input (possibly cut short). */
export function readToolPath(title: string, detail: string | undefined): string | undefined {
  if (!/^read$/i.test(title.trim()) || !detail) return undefined;
  const match = detail.match(/"(?:file_path|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!match) return undefined;
  try { return JSON.parse(`"${match[1]}"`) as string; } catch { return undefined; }
}

export function summaryPrompt(files: { path: string; text: string }[]): string {
  return [
    'Write a reference summary of each file below for other coding agents, so they can often skip reading the whole file.',
    '',
    'Each summary covers:',
    'Purpose: one or two sentences on what the file does and where it fits in the project.',
    'Definitions: every top-level or exported function, class, method, type and constant as a bare signature (name, parameters, return type), one per line, without bodies. Most definitions are self-explanatory from their name and signature and need no description. Only add a few words when the signature alone would leave a reader unsure what it does.',
    'Notes: only what someone using or editing the file could not tell from the signatures: state it reads or changes outside its own scope, I/O it performs (files, network, processes, storage), events or callbacks it registers, setup or call order it requires, assumptions callers must respect, and surprising behavior such as caching, retries or silently ignored errors. Leave notes out when there are none.',
    '',
    'Write plain text with no Markdown: no headings, bullets, bold, tables or code fences. Be concise and factual, and describe only what is in the file. For data or config files, describe the purpose and structure instead.',
    '',
    'Start each summary with a line "=== SUMMARY <path> ===" using the exact path given, and write nothing before the first one. Do not use tools.',
    ...files.map(file => `\n=== FILE ${file.path} ===\n${file.text}\n=== END FILE ${file.path} ===`),
  ].join('\n');
}

/** Splits a summary reply into one summary per requested path. */
export function parseSummaries(reply: string, paths: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const clean = (body: string): string => body.trim().replace(/^```[a-z]*\n/i, '').replace(/\n```$/, '').trim().slice(0, MAX_SUMMARY_CHARS);
  const marks = [...reply.matchAll(/^\s*=== SUMMARY (.+?) ===\s*$/gm)];
  marks.forEach((mark, index) => {
    const path = mark[1].trim();
    const body = clean(reply.slice(mark.index! + mark[0].length, marks[index + 1]?.index ?? reply.length));
    if (paths.includes(path) && body) result.set(path, body);
  });
  // A single-file reply without the header is still that file's summary.
  if (!marks.length && paths.length === 1 && clean(reply)) result.set(paths[0], clean(reply));
  return result;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
async function readText(path: string): Promise<string | undefined> {
  try {
    const bytes = await fs.readFile(path);
    return bytes.includes(0) ? undefined : decoder.decode(bytes);
  } catch { return undefined; }
}

/**
 * Per-workspace file summaries, written only when an agent reads a file whose summary is missing or
 * out of date. A worker summarizes queued files in batches on the summary model. Summaries are keyed
 * by path and checked against the reader's own copy.
 */
export class FileSummaries {
  private data?: Promise<Record<string, FileSummary>>;
  private readonly pending = new Map<string, { cwd: string; done: Promise<void>; finish(): void }>();
  private timer?: NodeJS.Timeout;
  private saveTimer?: NodeJS.Timeout;
  private working = false;
  private disposed = false;

  public constructor(private readonly options: SummaryOptions) {}

  /**
   * Queues `path` as it is in `cwd`, resolving once the worker has handled it. Files whose summary
   * already matches are skipped when the worker reaches them.
   */
  public request(cwd: string, path: string): Promise<void> {
    if (this.disposed || !this.options.enabled()) return Promise.resolve();
    const rel = normalizePath(cwd, path);
    if (!rel || this.options.excluded?.(rel)) return Promise.resolve();
    const queued = this.pending.get(rel);
    if (queued) return queued.done;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    this.pending.set(rel, { cwd, done, finish });
    this.schedule();
    return done;
  }

  /**
   * Reply for read_file_summaries, checked against the files in `cwd`. Missing and stale file summaries are
   * written first. Folders get an overview built from stored summaries, which never writes any.
   */
  public async lookup(cwd: string, paths: string[]): Promise<string> {
    const data = await this.load();
    const entries: ({ note: string } | { path: string })[] = [];
    for (const raw of paths) {
      const trimmed = raw.trim();
      const root = !trimmed || /^[./\\]+$/.test(trimmed);
      const rel = root ? '' : normalizePath(cwd, trimmed);
      if (rel === undefined) { entries.push({ note: `File: ${trimmed}\nOutside the working copy.` }); continue; }
      const stat = await fs.stat(join(cwd, rel)).catch(() => undefined);
      if (stat?.isDirectory()) { entries.push({ note: await this.folderOverview(cwd, rel, data) }); continue; }
      entries.push({ path: rel });
    }
    const texts = new Map<string, string | undefined>();
    for (const entry of entries) if ('path' in entry && !texts.has(entry.path)) texts.set(entry.path, await readText(join(cwd, entry.path)));
    const current = (path: string): boolean => { const text = texts.get(path); return text !== undefined && data[path]?.hash === hashText(text); };
    await Promise.all([...texts].filter(([path, text]) => text !== undefined && !current(path)).map(([path]) => this.request(cwd, path)));

    const sections: string[] = [];
    let size = 0;
    for (const entry of entries) {
      let section: string;
      if ('note' in entry) section = entry.note;
      else if (texts.get(entry.path) === undefined) section = `File: ${entry.path}\nNot found, or not a text file.`;
      else if (!data[entry.path]) section = `File: ${entry.path}\nNo summary could be written. Read the file.`;
      else if (!current(entry.path)) section = `File: ${entry.path} (out of date: rewriting this summary failed; read the file for exact code)\n${data[entry.path].summary}`;
      else section = `File: ${entry.path}\n${data[entry.path].summary}`;
      if (size + section.length > MAX_LOOKUP_CHARS) { sections.push('(Output limit reached; ask for fewer files.)'); break; }
      sections.push(section);
      size += section.length;
    }
    return sections.join('\n\n') || 'No summaries found.';
  }

  /** One line per entry directly in the folder: subfolders, then files with the first line of their stored summary. */
  private async folderOverview(cwd: string, rel: string, data: Record<string, FileSummary>): Promise<string> {
    const items = await fs.readdir(join(cwd, rel), { withFileTypes: true }).catch(() => []);
    const path = (name: string): string => rel ? `${rel}/${name}` : name;
    const shown = items.filter(item => (item.isDirectory() || item.isFile()) && !this.options.excluded?.(path(item.name)))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const lines = shown.slice(0, MAX_FOLDER_ENTRIES).map(item => {
      if (item.isDirectory()) return `${item.name}/`;
      const first = data[path(item.name)]?.summary.split('\n').find(line => line.trim())?.trim().replace(/^Purpose:\s*/i, '');
      return first ? `${item.name}: ${first.slice(0, 300)}` : `${item.name} (no summary yet)`;
    });
    if (shown.length > MAX_FOLDER_ENTRIES) lines.push(`(${shown.length - MAX_FOLDER_ENTRIES} more entries left out)`);
    return `Folder: ${rel || '.'}/\n${lines.join('\n') || '(empty)'}`;
  }

  public dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const item of this.pending.values()) item.finish();
    this.pending.clear();
    if (this.saveTimer) { clearTimeout(this.saveTimer); void this.write(); }
  }

  private load(): Promise<Record<string, FileSummary>> {
    return this.data ??= fs.readFile(this.options.file, 'utf8').then(text => {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== 'object') return {};
      return Object.fromEntries(Object.entries(parsed as Record<string, FileSummary>).filter(([, item]) =>
        item && typeof item.hash === 'string' && typeof item.summary === 'string'));
    }).catch(() => ({}));
  }

  private save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.write(); }, 1000);
  }

  private async write(): Promise<void> {
    try {
      const data = await this.load();
      await fs.mkdir(dirname(this.options.file), { recursive: true });
      await fs.writeFile(this.options.file, JSON.stringify(data));
    } catch (error) { this.options.log(`Saving file summaries failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private schedule(): void {
    if (this.working || this.disposed || !this.pending.size) return;
    if (this.timer) clearTimeout(this.timer);
    // A zero delay still lets requests made in the same tick share a batch.
    this.timer = setTimeout(() => { this.timer = undefined; void this.work(); }, 0);
  }

  private async work(): Promise<void> {
    this.working = true;
    try {
      while (!this.disposed && this.pending.size) {
        if (!this.options.enabled()) {
          for (const item of this.pending.values()) item.finish();
          this.pending.clear();
          break;
        }
        const data = await this.load();
        // One working copy per batch, since the model reads nothing but the prompt.
        const batch: { path: string; text: string; hash: string; finish(): void }[] = [];
        const cwd = this.pending.values().next().value!.cwd;
        let size = 0;
        for (const [path, item] of [...this.pending]) {
          if (batch.length >= BATCH_FILES) break;
          if (item.cwd !== cwd) continue;
          const text = await readText(join(cwd, path));
          const hash = text === undefined ? '' : hashText(text);
          if (text === undefined || !text.trim() || text.length > MAX_FILE_CHARS || data[path]?.hash === hash) { this.pending.delete(path); item.finish(); continue; }
          if (batch.length && size + text.length > BATCH_CHARS) continue;
          batch.push({ path, text, hash, finish: item.finish });
          size += text.length;
          this.pending.delete(path);
        }
        if (!batch.length) continue;
        const paths = batch.map(file => file.path);
        try {
          const summaries = parseSummaries(await this.options.generate(cwd, summaryPrompt(batch)), paths);
          for (const file of batch) {
            const summary = summaries.get(file.path);
            if (summary) data[file.path] = { hash: file.hash, summary, updatedAt: Date.now() };
          }
          const missing = paths.filter(path => !summaries.has(path));
          if (missing.length) this.options.log(`The summary model returned no summary for: ${missing.join(', ')}`);
          if (summaries.size) this.save();
        } catch (error) {
          this.options.log(`Summarizing ${paths.join(', ')} failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          for (const file of batch) file.finish();
        }
      }
    } finally {
      this.working = false;
      this.schedule();
    }
  }
}
