export const MAX_TITLE_LENGTH = 60;

/** Provisional title shown until (or instead of) a name model reply. */
export function firstMessageTitle(prompt: string): string {
  return (prompt.trim().replace(/\s+/g, ' ') || 'Image').slice(0, 48);
}

export function chatTitlePrompt(request: string): string {
  return 'Write a title for a coding chat that starts with the request below. Reply with ONLY the title: 2 to 6 words, '
    + 'sentence case, no quotes, no trailing punctuation. Name the concrete task, for example "Fix sidebar tab overflow". '
    + `Do not use any tools.\n\nRequest:\n${request.trim().slice(0, 4000)}`;
}

/** Extracts a clean title from a model reply, or returns undefined when nothing usable came back. */
export function cleanChatTitle(reply: string): string | undefined {
  const line = reply.split(/\r?\n/).map(item => item.trim()).find(Boolean);
  if (!line) return undefined;
  const title = line
    .replace(/^(?:#+\s*|[-*]\s+)/, '')
    .replace(/^\**\s*title\s*:\s*/i, '')
    .replace(/^[*_`"'“‘]+|[*_`"'”’]+$/g, '')
    .replace(/[.!?:;,\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) return undefined;
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : title;
}
