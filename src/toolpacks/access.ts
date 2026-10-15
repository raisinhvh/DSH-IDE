import type { ToolDescriptor } from './types';

/**
 * Agents see installed toolpacks as one line each and load the ones they need, so the tool
 * definitions of unused packs never reach their context.
 */

export const LOAD_TOOLPACK = 'load_toolpack';
export const RUN_TOOLPACK_TOOL = 'run_toolpack_tool';

/** First sentence of a pack description, kept to one short line. */
export function packLine(description: string): string {
  const first = description.trim().split('\n')[0].match(/^.*?[.!?](?=\s|$)/)?.[0] ?? description.trim().split('\n')[0];
  return first.length > 120 ? `${first.slice(0, 119).trimEnd()}…` : first;
}

export function loadToolpackTool(packs: { id: string; description: string }[]): ToolDescriptor {
  return {
    name: LOAD_TOOLPACK,
    description: `Turn on toolpacks: tools for external apps that you cannot reach through files. Loaded packs stay on for the rest of this chat. The reply lists each pack's tools and arguments; call them directly if they appear in your tool list, otherwise through ${RUN_TOOLPACK_TOOL}.\nAvailable packs:\n${packs.map(pack => `${pack.id}: ${packLine(pack.description)}`).join('\n')}`,
    inputSchema: { type: 'object', properties: { packs: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Pack names from the list.' } }, required: ['packs'] },
  };
}

export const runToolpackTool: ToolDescriptor = {
  name: RUN_TOOLPACK_TOOL,
  description: `Call a tool from a loaded toolpack when it is not in your tool list. Use the exact tool name and arguments from the ${LOAD_TOOLPACK} reply.`,
  inputSchema: { type: 'object', properties: { tool: { type: 'string', description: 'Full tool name, e.g. "blender_tree".' }, arguments: { type: 'object', description: 'The tool\'s arguments.' } }, required: ['tool'] },
};

/** Reply to load_toolpack: each tool's name, description and argument schema. */
export function describePackTools(tools: ToolDescriptor[]): string {
  return tools.map(tool => `${tool.name}: ${tool.description}\nArguments: ${JSON.stringify(tool.inputSchema)}`).join('\n\n');
}

/** Pack names written as "/name" anywhere in a message, in order, without repeats. */
export function packCommands(text: string, ids: Iterable<string>): string[] {
  const known = new Set(ids);
  const found: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)\/([a-z][a-z0-9_]*)(?=$|[\s.,;:!?)])/gim)) {
    const id = match[1].toLowerCase();
    if (known.has(id) && !found.includes(id)) found.push(id);
  }
  return found;
}
