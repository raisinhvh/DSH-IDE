import { buildHandoff, ChatMessage, HANDOFF_OPENING } from './handoff';

export interface Checkpoint { summary: string; keepFiles: string[] }

/** Validate the model-supplied checkpoint without accepting empty text or invalid paths. */
export function parseCheckpoint(args: Record<string, unknown>): Checkpoint {
  if (typeof args.summary !== 'string' || !args.summary.trim()) throw new Error('summary is required.');
  if (typeof args.reason !== 'string' || !args.reason.trim()) throw new Error('reason is required.');
  if (args.keep_files !== undefined && (!Array.isArray(args.keep_files) || args.keep_files.some(file => typeof file !== 'string' || !file.trim()))) {
    throw new Error('keep_files must be an array of non-empty strings.');
  }
  return { summary: args.summary.trim(), keepFiles: (args.keep_files as string[] | undefined) || [] };
}

/** Build a handoff from the agent's own summary and optional file names. */
export function checkpointHandoff(history: ChatMessage[], checkpoint: Checkpoint, toolAvailable: boolean): string {
  const files = checkpoint.keepFiles.length ? `\n\nFiles to re-read if needed: ${checkpoint.keepFiles.join(', ')}` : '';
  const text = buildHandoff(history, checkpoint.summary + files, toolAvailable);
  if (history.length > (toolAvailable ? 2 : 6)) return text;
  if (text) return text.replace(HANDOFF_OPENING, `${HANDOFF_OPENING}\n\nSummary:\n${checkpoint.summary}${files}`);
  return `${HANDOFF_OPENING}\n\nSummary:\n${checkpoint.summary}${files}`;
}
