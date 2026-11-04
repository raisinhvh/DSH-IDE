/**
 * When a chat moves to a new agent session (another model, an edited message, or a compaction), the new agent
 * gets a summary of the conversation plus the latest exchange word for word, and can fetch or search older
 * messages, including the tools each turn used, with read_chat_history.
 */

/** `tools` lists the calls an assistant turn made, one short line each. */
export interface ChatMessage { role: 'user' | 'assistant'; text: string; tools?: string[] }

export const CHAT_HISTORY_TOOL = 'read_chat_history';

/** Messages kept word for word: the latest exchange, or more when the agent cannot fetch older ones. */
export const KEEP_WITH_TOOL = 2;
export const KEEP_WITHOUT_TOOL = 6;
/** Tool lines kept per turn, and characters per line. */
export const MAX_TURN_TOOLS = 60;
export const MAX_TOOL_LINE = 160;

const MAX_SUMMARY_INPUT = 100_000;
const MAX_MESSAGE_CHARS = 10_000;
const MAX_HISTORY_CHARS = 80_000;

/** One tool line for the transcript: the name plus a short detail on one line. */
export function toolLine(title: string, detail?: string): string {
  const text = `${title}${detail ? ` ${detail}` : ''}`.replace(/\s+/g, ' ').trim();
  return text.length > MAX_TOOL_LINE ? `${text.slice(0, MAX_TOOL_LINE - 1)}…` : text;
}

export function formatMessages(messages: ChatMessage[], maxChars = Infinity, withTools = false): string {
  return messages.map(item => {
    const text = item.text.length > maxChars ? `${item.text.slice(0, maxChars)}\n[cut at ${maxChars} characters]` : item.text;
    const tools = withTools && item.tools?.length ? `${text ? '\n' : ''}[Tools: ${item.tools.join('; ')}]` : '';
    return `${item.role === 'user' ? 'User' : 'Assistant'}: ${text}${tools}`;
  }).join('\n\n');
}

export function handoffSummaryPrompt(messages: ChatMessage[]): string {
  let text = formatMessages(messages, Infinity, true);
  if (text.length > MAX_SUMMARY_INPUT) text = `[earlier messages cut]\n${text.slice(-MAX_SUMMARY_INPUT)}`;
  return [
    'Summarize this user/coding-agent conversation for the agent that continues it: goals, stated decisions and preferences, work done (files changed, commands run), open items. Keep exact paths, names and values; drop anything no longer relevant.',
    'Plain text, at most about 400 words. Do not use tools.',
    '',
    text,
  ].join('\n');
}

/** The handoff block that opens the first prompt of a new session. */
export function buildHandoff(history: ChatMessage[], summary: string | undefined, toolAvailable: boolean): string {
  if (!history.length) return '';
  const keep = toolAvailable && summary ? KEEP_WITH_TOOL : KEEP_WITHOUT_TOOL;
  const recent = history.slice(-keep);
  const older = history.length - recent.length;
  const parts = ['This conversation continues from an earlier session.'];
  if (older && summary) parts.push(`Summary of the ${older} earlier messages:\n${summary.trim()}`);
  else if (older) parts.push(`(${older} earlier messages are not shown.)`);
  parts.push(`Latest messages, word for word:\n${formatMessages(recent, MAX_MESSAGE_CHARS)}`);
  if (older && toolAvailable) parts.push(`${CHAT_HISTORY_TOOL} returns earlier messages and the tools they used; pass query to search them.`);
  return parts.join('\n\n');
}

/** Messages whose text or tool lines contain every word of the query. */
function matching(history: ChatMessage[], query: string): ChatMessage[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return history.filter(item => {
    const text = `${item.text}\n${(item.tools || []).join('\n')}`.toLowerCase();
    return words.every(word => text.includes(word));
  });
}

/** Reply for read_chat_history: the last `count` messages (or matches for `query`), oldest first, within an output limit. */
export function chatHistoryReply(history: ChatMessage[], count: number, query?: string): string {
  if (!history.length) return 'There are no earlier messages.';
  const pool = query?.trim() ? matching(history, query) : history;
  if (!pool.length) return `No earlier messages match "${query?.trim()}".`;
  const wanted = Math.max(1, Math.min(Math.floor(count) || 10, 100));
  const picked: string[] = [];
  let size = 0;
  for (const item of pool.slice(-wanted).reverse()) {
    const text = formatMessages([item], MAX_MESSAGE_CHARS, true);
    if (size + text.length > MAX_HISTORY_CHARS) break;
    picked.unshift(text);
    size += text.length;
  }
  const left = pool.length - picked.length;
  return `${left ? `(${left} earlier ${query?.trim() ? 'matches' : 'messages'} not shown.)\n\n` : ''}${picked.join('\n\n')}`;
}
