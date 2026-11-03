/** Keeps the original system text while sending instruction changes once in the user message. */
export function promptPrefix(current: string, resumed: boolean, original?: string, last?: string): { system: string; last: string; note: string } {
  if (!resumed || original === undefined) return { system: current, last: current, note: '' };
  return { system: original, last: current, note: current === (last ?? original) ? '' : `[DSH: your instructions changed]\n${current}` };
}

/** Suppress tool-list notifications only for Claude sessions that lack ToolSearch. */
export function skipToolListChanged(provider: string, tools?: string[]): boolean {
  return provider === 'claude-cli' && !!tools && !tools.some(tool => /(?:^|[./_])ToolSearch$/i.test(tool));
}
