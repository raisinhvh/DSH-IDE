/** Slash commands typed at the start of a chat message. Add an entry here to offer a new command in the composer menu. */
export interface SlashCommand { name: string; description: string; usage: string }

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'job', description: 'Plan a checklist from your spec, then work and review until it passes', usage: '/job <spec>' },
];

/** Splits a message that starts with a known `/name`. Unknown commands return undefined so they are sent as ordinary text. */
export function parseSlash(text: string): { name: string; args: string } | undefined {
  const match = /^\s*\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match) return undefined;
  const name = match[1].toLowerCase();
  if (!SLASH_COMMANDS.some(command => command.name === name)) return undefined;
  return { name, args: (match[2] || '').trim() };
}
