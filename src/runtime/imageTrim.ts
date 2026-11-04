import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Images a resumed Claude session keeps; older ones are replaced by a short note. */
export const KEEP_IMAGES = 5;

/** Text that takes an old image's place. Claude Code stores the image's file path in a text block next to it, so that path stays. */
export const TRIMMED_IMAGE_NOTE = '[Image removed by DSH to save context. Open its file again if you still need it.]';

type Block = Record<string, unknown>;

const isImage = (block: unknown): boolean => !!block && typeof block === 'object' && (block as Block).type === 'image';

/** Image blocks of one transcript line, in order: user content images and images inside tool results. */
function imageSlots(entry: Record<string, unknown>): { list: Block[]; index: number }[] {
  const message = entry.message as Block | undefined;
  if (entry.type !== 'user' || !message || !Array.isArray(message.content)) return [];
  const slots: { list: Block[]; index: number }[] = [];
  const content = message.content as Block[];
  content.forEach((block, index) => {
    if (isImage(block)) slots.push({ list: content, index });
    else if (block?.type === 'tool_result' && Array.isArray(block.content)) {
      const inner = block.content as Block[];
      inner.forEach((item, innerIndex) => { if (isImage(item)) slots.push({ list: inner, index: innerIndex }); });
    }
  });
  return slots;
}

/**
 * Replaces every image but the last `keep` in a Claude Code session transcript (JSONL lines) with a note.
 * Lines without images, and lines that are not JSON, are returned unchanged.
 */
export function trimImageLines(lines: string[], keep = KEEP_IMAGES): { lines: string[]; removed: number } {
  const parsed = lines.map(line => {
    if (!line.includes('"image"')) return undefined;
    try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
  });
  const slots = parsed.flatMap((entry, line) => entry ? imageSlots(entry).map(slot => ({ ...slot, line })) : []);
  const drop = slots.slice(0, Math.max(0, slots.length - keep));
  if (!drop.length) return { lines, removed: 0 };
  const changed = new Set<number>();
  for (const slot of drop) {
    slot.list[slot.index] = { type: 'text', text: TRIMMED_IMAGE_NOTE };
    changed.add(slot.line);
  }
  return { lines: lines.map((line, index) => changed.has(index) ? JSON.stringify(parsed[index]) : line), removed: drop.length };
}

/** The transcript file of a Claude session under a CLAUDE_CONFIG_DIR. The project folder name depends on the drive letter's case, so every one is checked. */
async function sessionFile(configDir: string, sessionId: string): Promise<string | undefined> {
  const projects = join(configDir, 'projects');
  const folders = await readdir(projects, { withFileTypes: true }).catch(() => []);
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const file = join(projects, folder.name, `${sessionId}.jsonl`);
    if ((await stat(file).catch(() => undefined))?.isFile()) return file;
  }
  return undefined;
}

/**
 * Keeps only the last `keep` images in a saved Claude session, so the next `--resume` sends fewer.
 * Changing earlier messages re-caches the conversation from that point, so callers only do this when the cache has expired anyway.
 * Returns how many images were removed.
 */
export async function trimSessionImages(configDir: string, sessionId: string, keep = KEEP_IMAGES): Promise<number> {
  const file = await sessionFile(configDir, sessionId);
  if (!file) return 0;
  const text = await readFile(file, 'utf8');
  const trailing = text.endsWith('\n');
  const result = trimImageLines((trailing ? text.slice(0, -1) : text).split('\n'), keep);
  if (!result.removed) return 0;
  const temporary = `${file}.dsh-trim`;
  await writeFile(temporary, result.lines.join('\n') + (trailing ? '\n' : ''), 'utf8');
  await rename(temporary, file);
  return result.removed;
}
