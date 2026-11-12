/**
 * Tool calls arrive with each harness's own names and raw arguments: Claude Code sends `Bash` with a JSON input,
 * Codex sends `Command` with a wrapped PowerShell line, MCP tools carry `mcp__server__tool` prefixes. The sidebar
 * shows one short name per call (`ripgrep`, `Read`, `Edit`) plus a short detail, and the full call on hover.
 */

export type ToolKind = 'read' | 'search' | 'shell' | 'edit' | 'other';

export interface ToolDisplay {
  kind: ToolKind;
  title: string;
  detail?: string;
  /** The whole call, shown on hover. */
  full?: string;
}

/** Built-in and DSH tool names, lowercased with separators removed, to their short name and kind. */
const NAMED_TOOLS: Record<string, { title: string; kind: ToolKind; field?: string }> = {
  read: { title: 'Read', kind: 'read' },
  readfile: { title: 'Read', kind: 'read' },
  view: { title: 'Read', kind: 'read' },
  viewimage: { title: 'Image', kind: 'read' },
  notebookread: { title: 'Read', kind: 'read' },
  listdir: { title: 'List', kind: 'read' },
  ls: { title: 'List', kind: 'read' },
  readfilesummaries: { title: 'Summaries', kind: 'read' },
  readchathistory: { title: 'History', kind: 'read' },
  grep: { title: 'Search', kind: 'search' },
  search: { title: 'Search', kind: 'search' },
  codebasesearch: { title: 'Search', kind: 'search' },
  glob: { title: 'Find', kind: 'search' },
  findfiles: { title: 'Find', kind: 'search' },
  websearch: { title: 'Web search', kind: 'search' },
  webfetch: { title: 'Fetch', kind: 'search' },
  fetch: { title: 'Fetch', kind: 'search' },
  toolsearch: { title: 'Tool search', kind: 'search' },
  edit: { title: 'Edit', kind: 'edit' },
  multiedit: { title: 'Edit', kind: 'edit' },
  fileedit: { title: 'Edit', kind: 'edit' },
  strreplace: { title: 'Edit', kind: 'edit' },
  applypatch: { title: 'Edit', kind: 'edit' },
  notebookedit: { title: 'Edit', kind: 'edit' },
  write: { title: 'Write', kind: 'edit' },
  writefile: { title: 'Write', kind: 'edit' },
  delegatetask: { title: 'Delegate', kind: 'other' },
  waitforsubagents: { title: 'Wait', kind: 'other' },
  cancelsubagent: { title: 'Cancel', kind: 'other' },
  listsubagents: { title: 'Subagents', kind: 'other' },
  batch: { title: 'Batch', kind: 'other' },
  sendmedia: { title: 'Media', kind: 'other' },
  generateimage: { title: 'Image', kind: 'other' },
  askuserquestion: { title: 'Question', kind: 'other' },
  askquestions: { title: 'Question', kind: 'other' },
  checkpoint: { title: 'Checkpoint', kind: 'other' },
  todowrite: { title: 'Todo', kind: 'other' },
  updateplan: { title: 'Plan', kind: 'other' },
  skill: { title: 'Skill', kind: 'other' },
  compactcontext: { title: 'Compact', kind: 'other' },
};

/** Shell programs with a friendlier name. */
const PROGRAM_NAMES: Record<string, string> = {
  rg: 'ripgrep',
};

/** Programs whose subcommand says what happened (`git status`, `npm test`). */
const SUBCOMMAND_PROGRAMS = new Set(['git', 'npm', 'npx', 'pnpm', 'yarn', 'cargo', 'gh', 'dotnet', 'go', 'docker', 'rojo']);

const SHELL_TOOLS = new Set(['bash', 'powershell', 'pwsh', 'shell', 'command', 'commandexecution', 'terminal', 'runterminalcmd', 'runcommand', 'execcommand', 'localshell']);

/** Argument fields that hold the useful part of a call, in order of preference. */
const DETAIL_FIELDS = ['file_path', 'path', 'notebook_path', 'pattern', 'query', 'url', 'agent', 'skill', 'description', 'prompt', 'task'];

const MAX_DETAIL = 120;

function compactKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** `mcp__dsh-delegate__read_file` and `dsh-delegate.read_file` become `read_file`. */
function bareName(title: string): string {
  const trimmed = title.trim();
  const mcp = trimmed.match(/^mcp__.+?__(.+)$/);
  if (mcp) {
    return mcp[1];
  }
  const dotted = trimmed.match(/^[\w-]+[./](\w+)$/);
  return dotted ? dotted[1] : trimmed;
}

function parseArguments(detail: string | undefined): Record<string, unknown> | undefined {
  if (!detail || !detail.trim().startsWith('{')) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(detail);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL - 1)}…` : flat;
}

/** Long absolute paths keep their last three parts. */
function shortPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  const absolute = /^([a-z]:)?[\\/]/i.test(path);
  return absolute && parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : path.replace(/\\/g, '/');
}

function unquote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === '\'') && trimmed.endsWith(trimmed[0])) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Strips `bash -lc '…'`, `pwsh.exe -Command "…"` and `cmd /c …` wrappers. */
export function unwrapShell(command: string): string {
  let current = command.trim();
  for (let depth = 0; depth < 3; depth++) {
    const shell = current.match(/^(?:"[^"]*?(?:bash|sh|pwsh|powershell|cmd)(?:\.exe)?"|\S*?(?:bash|sh|pwsh|powershell|cmd)(?:\.exe)?)\s+(.*)$/is);
    if (!shell) {
      break;
    }
    const rest = shell[1].replace(/^(?:-(?:NoProfile|NonInteractive|NoLogo|ExecutionPolicy\s+\S+|l|i)\s+)*/i, '');
    const body = rest.match(/^(?:-c|-lc|-Command|-c?ommand|\/c|\/s\s+\/c)\s+([\s\S]*)$/i);
    if (!body) {
      break;
    }
    current = unquote(body[1]);
  }
  return current;
}

/** The program a command line runs first, skipping `cd`, env assignments and similar setup. */
export function commandProgram(command: string): string | undefined {
  const segments = unwrapShell(command).split(/\s*(?:&&|\|\||;|\||\r?\n)\s*/);
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(token => !/^\w+=/.test(token) && !/^\$env:\w+\s*=/.test(token));
    if (!tokens.length) {
      continue;
    }
    const first = unquote(tokens[0]).replace(/^&\s*/, '');
    const program = (first === '&' ? unquote(tokens[1] || '') : first).replace(/\\/g, '/').split('/').pop()?.replace(/\.(exe|cmd|bat|ps1)$/i, '') || '';
    if (!program || /^(cd|set-location|pushd|sl|export|set|\$\w+)$/i.test(program)) {
      continue;
    }
    const name = PROGRAM_NAMES[program.toLowerCase()] || program;
    const subcommand = tokens.slice(first === '&' ? 2 : 1).find(token => !token.startsWith('-'));
    return SUBCOMMAND_PROGRAMS.has(program.toLowerCase()) && subcommand && /^[\w:-]+$/.test(subcommand) ? `${name} ${subcommand}` : name;
  }
  return undefined;
}

/** One tool call as the sidebar shows it, whichever harness sent it. */
export function displayTool(rawTitle: string, rawDetail?: string): ToolDisplay {
  // Cursor titles carry the call itself: "`rg -n foo`" or "Read src/a.ts".
  const quoted = rawTitle.trim().match(/^`([^`]+)`$/);
  if (quoted) {
    return { kind: 'shell', title: commandProgram(quoted[1]) || 'Shell', full: quoted[1] };
  }
  const spaced = rawTitle.trim().match(/^(\S+)\s+(.+)$/);
  if (spaced && NAMED_TOOLS[compactKey(spaced[1])] && !NAMED_TOOLS[compactKey(rawTitle)]) {
    const named = NAMED_TOOLS[compactKey(spaced[1])];
    const rest = spaced[2].trim();
    return { kind: named.kind, title: named.title, detail: /[\\/]/.test(rest) ? shortPath(rest) : oneLine(rest), full: rawTitle.trim() };
  }
  const name = bareName(rawTitle);
  const key = compactKey(name);
  const args = parseArguments(rawDetail);
  const command = typeof args?.command === 'string' ? args.command : Array.isArray(args?.command) ? (args.command as unknown[]).join(' ') : SHELL_TOOLS.has(key) && !args ? rawDetail : undefined;
  if (SHELL_TOOLS.has(key) || (key === 'mcptool' && command)) {
    const full = command?.trim();
    return { kind: 'shell', title: full ? commandProgram(full) || 'Shell' : 'Shell', full: full || undefined };
  }
  const named = NAMED_TOOLS[key];
  let detail: string | undefined;
  if (args) {
    const field = DETAIL_FIELDS.find(item => typeof args[item] === 'string' && (args[item] as string).trim());
    if (field) {
      const value = args[field] as string;
      detail = /path$/.test(field) ? shortPath(value) : oneLine(value);
    }
  } else if (rawDetail?.trim()) {
    detail = /^([a-z]:)?[\\/]/i.test(rawDetail.trim()) ? shortPath(rawDetail.trim()) : oneLine(rawDetail);
  }
  const full = rawDetail?.trim() ? `${name} ${rawDetail.trim()}` : undefined;
  if (named) {
    return { kind: named.kind, title: named.title, detail, full };
  }
  const words = name.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  const title = words ? words[0].toUpperCase() + words.slice(1).toLowerCase() : 'Tool';
  return { kind: 'other', title, detail, full };
}
