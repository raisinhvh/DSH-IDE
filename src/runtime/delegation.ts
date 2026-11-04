/** Subagents get a bridge that only exposes custom toolpack tools, so they cannot delegate further. */
export const TOOLPACK_SCOPE = 'toolpacks';

/** Whether a bridge config offers delegate_task, as opposed to only toolpack tools. */
export function canDelegate(delegate?: { env: Record<string, string> }): boolean {
  return !!delegate && delegate.env.DSH_DELEGATE_SCOPE !== TOOLPACK_SCOPE;
}

export const WAIT_SUBAGENTS = 'wait_for_subagents';
export const CANCEL_SUBAGENT = 'cancel_subagent';
export type AfterTurn = 'resume' | 'hold' | 'cancel';

/** DSH profiles are the only supported source of subagents. */
export function delegationInstructions(available: boolean, options?: { explorer?: boolean }): string {
  const native = 'Never use native Agent/Task/spawn_agent tools or start agents from a shell.';
  return available
    ? `DSH subagents: run them only with delegate_task (dsh-delegate MCP), using exact names from list_subagents. Start independent tasks together (edit subagents need disjoint files); background: true lets you keep working. ${native}`
      + (options?.explorer ? ' For searches across several files, delegate to explorer and ask for a short answer with file:line references.' : '')
    : `DSH subagents: no delegate tool is available in this session. ${native} If a task needs a subagent, say delegation is unavailable.`;
}

export function isNativeSubagentTool(tool: string): boolean {
  return /^(?:Agent|Task|Subagent(?: activity)?|(?:collaboration[./])?(?:spawn_agent|spawnAgent))$/i.test(tool.trim());
}

/** MCP providers expose either the bare tool name or a qualified name. */
export function isDelegationTool(tool: string): boolean {
  return /^(?:(?:mcp[._/]{1,2})?dsh[-_]delegate[._/]{1,2})?delegate_task$/i.test(tool.trim());
}
