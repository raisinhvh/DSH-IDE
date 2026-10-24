/** Smart Auto: a decider model picks, per message, one model + effort from the user's ranked list (1 = smartest). */

/** The model picker id for Smart Auto. Configured models may not use this name. */
export const SMART_AUTO = 'Smart Auto';
export const MAX_RANKS = 12;
/** Exchanges from the chat so far that the decider sees, and how much of each. */
export const DECIDER_HISTORY = 6;
const HISTORY_CHARS = 1500;
const REQUEST_CHARS = 6000;
export const MAX_NOTE = 500;

/** `note` is the user's own guidance on when to use this entry. */
export interface SmartAutoRank { model: string; effort?: string; note?: string }

/** Drops malformed entries from the dsh.smartAutoRanks setting. */
export function normalizeRanks(value: unknown): SmartAutoRank[] {
  if (!Array.isArray(value)) return [];
  const text = (item: unknown): string | undefined => typeof item === 'string' && item.trim() ? item.trim() : undefined;
  return value.flatMap(item => {
    const fields = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const model = text(fields.model);
    return model ? [{ model, effort: text(fields.effort), note: text(fields.note)?.slice(0, MAX_NOTE) }] : [];
  }).slice(0, MAX_RANKS);
}

export function rankLabel(rank: SmartAutoRank): string {
  return rank.effort ? `${rank.model} (${rank.effort})` : rank.model;
}

const clip = (text: string, limit: number): string => text.length > limit ? `${text.slice(0, limit)}…` : text;

export function deciderPrompt(ranks: SmartAutoRank[], history: { role: 'user' | 'assistant'; text: string }[], request: string): string {
  const recent = history.slice(-DECIDER_HISTORY).map(item => `${item.role === 'user' ? 'User' : 'Assistant'}: ${clip(item.text.trim(), HISTORY_CHARS)}`);
  return [
    `You choose which model handles the next turn of a coding agent chat. The models are ranked from smartest (1) to least smart (${ranks.length}). Smarter models are slower and cost more, so pick the least smart model that will do this request well.`
      + (ranks.some(rank => rank.note) ? ' Some models have the user\'s notes on when to use them. Follow those notes first.' : ''),
    `Models:\n${ranks.map((rank, index) => `${index + 1}. ${rankLabel(rank)}${rank.note ? ` (user's note: ${rank.note.replace(/\s+/g, ' ')})` : ''}`).join('\n')}`,
    recent.length ? `Recent conversation (oldest first):\n${recent.join('\n\n')}` : '',
    `Next user message:\n${clip(request.trim(), REQUEST_CHARS) || '(attachments only)'}`,
    'Reply with one line only: the model\'s number, a "|", and a short reason. Example: 2 | Small edit in one file.',
  ].filter(Boolean).join('\n\n');
}

/** Reads "N | reason" from the decider's first non-empty line. Returns undefined when N is not a listed rank. */
export function parseDecision(reply: string, count: number): { rank: number; reason?: string } | undefined {
  const line = reply.split(/\r?\n/).map(item => item.trim()).find(Boolean);
  const match = line?.replace(/[*`]/g, '').match(/^\D{0,12}?(\d+)\s*(?:[|:\-–—.)]\s*(.*))?$/);
  if (!match) return undefined;
  const rank = Number(match[1]);
  if (!Number.isInteger(rank) || rank < 1 || rank > count) return undefined;
  const reason = match[2]?.trim().slice(0, 200);
  return { rank, reason: reason || undefined };
}
