/** DSH profiles are the only supported source of subagents. */
export function delegationInstructions(available: boolean): string {
  return available
    ? 'DSH delegation: delegate_task on the dsh-delegate MCP server is the subagent command. Use list_subagents to discover configured profiles and pass their exact names to delegate_task. Use only those profiles for subagent requests. Independent tasks can run in parallel: issue several delegate_task calls in the same turn instead of one after another, giving edit subagents disjoint files. Do not use native Agent, Task, collaboration or spawn_agent tools, or launch another agent through a shell command.'
    : 'DSH delegation: no delegate tool is available in this session. Do not spawn subagents using native Agent, Task, collaboration or spawn_agent tools, or launch another agent through a shell command. Explain that delegation is unavailable if the task requires a subagent.';
}

export function isNativeSubagentTool(tool: string): boolean {
  return /^(?:Agent|Task|Subagent(?: activity)?|(?:collaboration[./])?(?:spawn_agent|spawnAgent))$/i.test(tool.trim());
}

/** MCP providers expose either the bare tool name or a qualified name. */
export function isDelegationTool(tool: string): boolean {
  return /^(?:(?:mcp[._/]{1,2})?dsh[-_]delegate[._/]{1,2})?delegate_task$/i.test(tool.trim());
}
