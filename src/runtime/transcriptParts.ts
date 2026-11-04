import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ChatMessage, formatMessages, MAX_MESSAGE_CHARS } from './handoff';

/**
 * Experimental, with auto compaction: a new session does not get one summary of everything before it. The earlier
 * messages are split by topic into parts, each saved as a file under .dsh/transcripts/<chat>/ with a short summary.
 * Every part's summary opens the new session, and the agent reads a part's file when it needs the detail.
 */

/** Messages from..to-1 of the chat's transcript, with the summary the agent always sees. */
export interface TranscriptPart { from: number; to: number; title: string; summary: string }

export const PARTS_DIR = '.dsh/transcripts';

/** Characters of conversation per summarizing call, per message inside it, and per part a call aims for. */
const MAX_WINDOW_CHARS = 120_000;
const MAX_PROMPT_MESSAGE = 6_000;
const PART_TARGET_CHARS = 25_000;
const MAX_PARTS_PER_WINDOW = 6;

const numbered = (history: ChatMessage[], from: number, to: number): string[] =>
  history.slice(from, to).map((item, index) => `[${from + index + 1}] ${formatMessages([item], MAX_PROMPT_MESSAGE, true)}`);

/** Splits from..to into windows that each fit one summarizing call, at message boundaries. */
export function partWindows(history: ChatMessage[], from: number, to: number): { from: number; to: number; text: string }[] {
  const lines = numbered(history, from, to);
  const windows: { from: number; to: number; text: string }[] = [];
  let start = 0;
  let size = 0;
  lines.forEach((line, index) => {
    if (index > start && size + line.length > MAX_WINDOW_CHARS) {
      windows.push({ from: from + start, to: from + index, text: lines.slice(start, index).join('\n\n') });
      start = index;
      size = 0;
    }
    size += line.length + 2;
  });
  if (start < lines.length) windows.push({ from: from + start, to, text: lines.slice(start).join('\n\n') });
  return windows;
}

export function partsPrompt(window: { from: number; to: number; text: string }): string {
  const most = Math.min(MAX_PARTS_PER_WINDOW, Math.max(1, Math.ceil(window.text.length / PART_TARGET_CHARS)));
  return [
    `This is part of a user/coding-agent conversation, messages ${window.from + 1} to ${window.to}. It is being archived: the agent that continues it sees only a summary of each part and reads a part in full when it needs the detail.`,
    `Split it into ${most === 1 ? 'a single part' : `1 to ${most} parts`} where the work changes subject. For each part give the number of its first message, a title of a few words, and a summary of at most about 120 words: goals, decisions and preferences, work done (files changed, commands run), open items. Keep exact paths, names and values.`,
    `Reply with JSON only: {"parts":[{"start":${window.from + 1},"title":"...","summary":"..."}]}. The first part starts at ${window.from + 1}. Do not use tools.`,
    '',
    window.text,
  ].join('\n');
}

/** Parts from a summarizing reply, or undefined if it is not usable. */
export function parsePartsReply(reply: string, from: number, to: number): TranscriptPart[] | undefined {
  const json = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1);
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return undefined; }
  const items = (parsed as { parts?: unknown })?.parts;
  if (!Array.isArray(items)) return undefined;
  const starts = new Map<number, { title: string; summary: string }>();
  for (const item of items) {
    const value = item as Record<string, unknown>;
    const start = Math.floor(Number(value?.start)) - 1;
    const summary = typeof value?.summary === 'string' ? value.summary.trim() : '';
    if (!summary || !(start >= from && start < to) || starts.has(start)) continue;
    starts.set(start, { title: typeof value.title === 'string' && value.title.trim() ? value.title.trim() : 'Untitled', summary });
  }
  const ordered = [...starts.entries()].sort(([a], [b]) => a - b);
  if (!ordered.length) return undefined;
  // The first part always starts at the window's first message.
  ordered[0][0] = from;
  return ordered.map(([start, value], index) => ({ from: start, to: ordered[index + 1]?.[0] ?? to, ...value }));
}

/** A part that could not be summarized still keeps its messages readable. */
export const unsummarizedPart = (from: number, to: number): TranscriptPart =>
  ({ from, to, title: `Messages ${from + 1}-${to}`, summary: 'Not summarized; read the file for what happened here.' });

export const partFileName = (index: number): string => `part-${String(index + 1).padStart(2, '0')}.md`;
export const partsDir = (chatId: string): string => `${PARTS_DIR}/${chatId}`;

/** Writes every part from the transcript, so the files always match it (the working copy may be new). */
export async function writeTranscriptParts(cwd: string, chatId: string, history: ChatMessage[], parts: TranscriptPart[]): Promise<void> {
  const dir = join(cwd, ...partsDir(chatId).split('/'));
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(cwd, ...PARTS_DIR.split('/'), '.gitignore'), '*\n');
  await Promise.all(parts.map((part, index) => writeFile(join(dir, partFileName(index)), [
    `# ${part.title}`,
    `Messages ${part.from + 1}-${part.to} of this chat.`,
    '',
    `Summary: ${part.summary}`,
    '',
    formatMessages(history.slice(part.from, part.to), Infinity, true),
    '',
  ].join('\n'))));
}

/** The handoff block that opens a new session: every part's summary, then the messages after the last part word for word. */
export function buildPartsHandoff(chatId: string, history: ChatMessage[], parts: TranscriptPart[]): string {
  const dir = partsDir(chatId);
  const covered = parts[parts.length - 1]?.to ?? 0;
  return [
    'This conversation continues from an earlier session.',
    `Its earlier messages are saved in ${dir}/, one file per part. You only see the summaries below; read a part when you need its detail.`,
    parts.map((part, index) => `- ${partFileName(index)} (messages ${part.from + 1}-${part.to}), ${part.title}: ${part.summary}`).join('\n'),
    `Latest messages, word for word:\n${formatMessages(history.slice(covered), MAX_MESSAGE_CHARS)}`,
  ].join('\n\n');
}
