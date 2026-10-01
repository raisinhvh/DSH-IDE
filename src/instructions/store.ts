import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export type InstructionKind = 'rule' | 'skill';
export type InstructionScope = 'workspace' | 'global';
type Base = 'ws' | 'dsh' | 'agents';

export interface InstructionRoots { workspace?: string; dshHome: string; agentsHome: string }
export interface InstructionItem {
  id: string;
  kind: InstructionKind;
  scope: InstructionScope;
  name: string;
  path: string;
  description?: string;
}
export interface InstructionSave {
  id?: string;
  kind: InstructionKind;
  scope: InstructionScope;
  file?: string;
  name?: string;
  description?: string;
  content: string;
}

export const WORKSPACE_RULE_FILES = ['AGENTS.md', 'AGENTS.local.md', 'CLAUDE.md', 'CLAUDE.local.md'];
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_INSTRUCTION_BYTES = 256 * 1024;

const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', '.next', '.turbo', '.npm-cache', '.system']);
const MAX_DEPTH = 6;
const MAX_ITEMS = 500;

const baseDir = (roots: InstructionRoots, base: Base): string | undefined =>
  base === 'ws' ? roots.workspace : base === 'dsh' ? roots.dshHome : roots.agentsHome;

function skillDescription(text: string): string | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const raw = frontmatter ? /^description:[ \t]*(.+)$/m.exec(frontmatter)?.[1]?.trim() : undefined;
  if (!raw) return undefined;
  const unquoted = /^(["'])(.*)\1$/.exec(raw)?.[2] ?? raw;
  return unquoted.slice(0, 200);
}

async function walk(directory: string, depth: number, visit: (file: string, name: string) => Promise<void>, budget: { left: number }): Promise<void> {
  if (budget.left <= 0) return;
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (budget.left <= 0 || entry.isSymbolicLink()) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH && !SKIPPED_DIRS.has(entry.name)) await walk(full, depth + 1, visit, budget);
    } else if (entry.isFile() && (entry.name === 'SKILL.md' || WORKSPACE_RULE_FILES.includes(entry.name))) {
      budget.left -= 1;
      await visit(full, entry.name);
    }
  }
}

async function describe(file: string): Promise<string | undefined> {
  try { return skillDescription((await fs.readFile(file, 'utf8')).slice(0, 4096)); }
  catch { return undefined; }
}

function skillItem(base: Base, scope: InstructionScope, rel: string, description?: string): InstructionItem {
  const parts = rel.split('/');
  return { id: `${base}:${rel}`, kind: 'skill', scope, name: parts[parts.length - 2] || rel, path: rel, description };
}

/** Rules and skills that exist on disk. Ids are `<base>:<posix path relative to that base>`. */
export async function listInstructions(roots: InstructionRoots): Promise<InstructionItem[]> {
  const items: InstructionItem[] = [];
  const budget = { left: MAX_ITEMS };
  const toRel = (root: string, file: string): string => relative(root, file).split(sep).join('/');
  if (roots.workspace) {
    const root = roots.workspace;
    await walk(root, 0, async (file, name) => {
      const rel = toRel(root, file);
      if (name === 'SKILL.md') items.push(skillItem('ws', 'workspace', rel, await describe(file)));
      else items.push({ id: `ws:${rel}`, kind: 'rule', scope: 'workspace', name: rel, path: rel });
    }, budget);
  }
  try { await fs.access(join(roots.dshHome, 'AGENTS.md')); items.push({ id: 'dsh:AGENTS.md', kind: 'rule', scope: 'global', name: 'AGENTS.md', path: 'AGENTS.md' }); }
  catch { /* no global rules yet */ }
  for (const [base, root] of [['dsh', roots.dshHome], ['agents', roots.agentsHome]] as const) {
    const skills = join(root, 'skills');
    await walk(skills, 0, async (file, name) => {
      if (name === 'SKILL.md') items.push(skillItem(base, 'global', toRel(root, file), await describe(file)));
    }, budget);
  }
  const order = (item: InstructionItem): number => (item.scope === 'workspace' ? 0 : 1) * 2 + (item.kind === 'rule' ? 0 : 1);
  return items.sort((a, b) => order(a) - order(b) || a.path.localeCompare(b.path));
}

function absolute(roots: InstructionRoots, id: string): string {
  const split = id.indexOf(':');
  const base = id.slice(0, split) as Base;
  const rel = id.slice(split + 1);
  const root = split > 0 && (base === 'ws' || base === 'dsh' || base === 'agents') ? baseDir(roots, base) : undefined;
  if (!root || !rel || rel.includes('\0') || rel.split('/').some(part => !part || part === '..')) throw new Error('Unknown rule or skill.');
  const file = resolve(root, ...rel.split('/'));
  if (!file.startsWith(resolve(root) + sep)) throw new Error('Unknown rule or skill.');
  return file;
}

async function find(roots: InstructionRoots, id: string): Promise<{ item: InstructionItem; file: string }> {
  const item = (await listInstructions(roots)).find(candidate => candidate.id === id);
  if (!item) throw new Error('That rule or skill no longer exists.');
  return { item, file: absolute(roots, id) };
}

export async function locateInstruction(roots: InstructionRoots, id: string): Promise<string> {
  return (await find(roots, id)).file;
}

export async function readInstruction(roots: InstructionRoots, id: string): Promise<string> {
  return fs.readFile((await find(roots, id)).file, 'utf8');
}

export async function removeInstruction(roots: InstructionRoots, id: string): Promise<{ item: InstructionItem; file: string }> {
  const found = await find(roots, id);
  await fs.rm(found.file);
  if (found.item.kind === 'skill') {
    try { await fs.rmdir(dirname(found.file)); } catch { /* skill folder holds other files */ }
  }
  return found;
}

function newSkillText(name: string, description: string, body: string): string {
  const summary = description.replace(/\s+/g, ' ').trim() || 'Describe when to use this skill.';
  return `---\nname: ${name}\ndescription: ${JSON.stringify(summary)}\n---\n\n${body.trim() ? body.replace(/\s+$/, '') : `# ${name}\n\nAdd instructions here.`}\n`;
}

/** Creates a new rule/skill, or overwrites an existing one when `id` is given. Returns the item and its absolute path. */
export async function saveInstruction(roots: InstructionRoots, request: InstructionSave): Promise<{ item: InstructionItem; file: string }> {
  if (typeof request.content !== 'string' || Buffer.byteLength(request.content) > MAX_INSTRUCTION_BYTES) throw new Error('Content is too large.');
  if (request.id !== undefined && typeof request.id !== 'string') throw new Error('Unknown rule or skill.');
  if (request.id) {
    const found = await find(roots, request.id);
    await fs.writeFile(found.file, request.content, 'utf8');
    return found;
  }
  if ((request.kind !== 'rule' && request.kind !== 'skill') || (request.scope !== 'workspace' && request.scope !== 'global')) throw new Error('Choose a rule or skill and where it applies.');
  let id: string;
  let text = request.content;
  if (request.kind === 'skill') {
    const name = String(request.name || '').trim();
    if (!SKILL_NAME.test(name)) throw new Error('Skill names use lowercase letters, numbers and hyphens.');
    if (request.scope === 'workspace' && !roots.workspace) throw new Error('Open a workspace folder to add workspace skills.');
    id = request.scope === 'workspace' ? `ws:.agents/skills/${name}/SKILL.md` : `agents:skills/${name}/SKILL.md`;
    text = newSkillText(name, String(request.description || ''), request.content);
  } else {
    const file = String(request.file || '');
    if (request.scope === 'workspace') {
      if (!roots.workspace) throw new Error('Open a workspace folder to add workspace rules.');
      if (!WORKSPACE_RULE_FILES.includes(file)) throw new Error('Choose a supported rules file.');
      id = `ws:${file}`;
    } else {
      if (file !== 'AGENTS.md') throw new Error('Global rules live in AGENTS.md.');
      id = 'dsh:AGENTS.md';
    }
    if (!text.trim()) text = '# Rules\n\nAdd instructions here.\n';
  }
  const target = absolute(roots, id);
  await fs.mkdir(dirname(target), { recursive: true });
  try { await fs.writeFile(target, text, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('That rule or skill already exists. Edit it from the list instead.');
    throw error;
  }
  const item = (await listInstructions(roots)).find(candidate => candidate.id === id);
  return { item: item ?? { id, kind: request.kind, scope: request.scope, name: request.name || String(request.file), path: id.slice(id.indexOf(':') + 1) }, file: target };
}
