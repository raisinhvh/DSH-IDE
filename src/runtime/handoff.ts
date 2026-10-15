/**
 * When a chat moves to a new agent session (another model, or an edited message), the new agent gets a
 * summary of the conversation plus the latest exchange word for word, and can fetch older messages
 * with read_chat_history.
 */

export interface ChatMessage { role: 'user' | 'assistant'; text: string }

export const CHAT_HISTORY_TOOL = 'read_chat_history';

/** Messages kept word for word: the latest exchange, or more when the agent cannot fetch older ones. */
export const KEEP_WITH_TOOL = 2;
export const KEEP_WITHOUT_TOOL = 6;

const MAX_SUMMARY_INPUT = 100_000;
const MAX_MESSAGE_CHARS = 10_000;
const MAX_HISTORY_CHARS = 80_000;

export function formatMessages(messages: ChatMessage[], maxChars = Infinity): string {
  return messages.map(item => {
    const text = item.text.length > maxChars ? `${item.text.slice(0, maxChars)}\n[cut at ${maxChars} characters]` : item.text;
    return `${item.role === 'user' ? 'User' : 'Assistant'}: ${text}`;
  }).join('\n\n');
}

export function handoffSummaryPrompt(messages: ChatMessage[]): string {
  let text = formatMessages(messages);
  if (text.length > MAX_SUMMARY_INPUT) text = `[earlier messages cut]\n${text.slice(-MAX_SUMMARY_INPUT)}`;
  return [
    'Summarize this conversation between a user and a coding agent for another agent that will continue it.',
    'Cover what the user wants, decisions and preferences they stated, what was done (files changed, commands run), and what is still open. Keep exact file paths, names and values. Leave out pleasantries and anything that no longer matters.',
    'Write plain text, at most about 300 words. Do not use tools.',
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
  if (older && toolAvailable) parts.push(`Call ${CHAT_HISTORY_TOOL} with a message count if you need earlier messages word for word.`);
  return parts.join('\n\n');
}

/** Reply for read_chat_history: the last `count` messages, oldest first, within an output limit. */
export function chatHistoryReply(history: ChatMessage[], count: number): string {
  if (!history.length) return 'There are no earlier messages.';
  const wanted = Math.max(1, Math.min(Math.floor(count) || 10, 100));
  const picked: string[] = [];
  let size = 0;
  for (const item of history.slice(-wanted).reverse()) {
    const text = formatMessages([item], MAX_MESSAGE_CHARS);
    if (size + text.length > MAX_HISTORY_CHARS) break;
    picked.unshift(text);
    size += text.length;
  }
  const left = history.length - picked.length;
  return `${left ? `(${left} earlier messages not shown.)\n\n` : ''}${picked.join('\n\n')}`;
}
