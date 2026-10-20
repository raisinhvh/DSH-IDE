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
export function delegationInstructions(available: boolean): string {
  return available
    ? 'DSH delegation: delegate_task on the dsh-delegate MCP server is the subagent command. Use list_subagents to discover configured profiles and pass their exact names to delegate_task. Use only those profiles for subagent requests. Independent tasks can run in parallel: issue several delegate_task calls in the same turn instead of one after another, giving edit subagents disjoint files. '
      + `To keep working while subagents run, pass background: true; delegate_task then returns a task id at once. Collect results with ${WAIT_SUBAGENTS} (it yields until they finish), stop one with ${CANCEL_SUBAGENT}, and choose with after_turn what happens if your turn ends first: "resume" (default) sends you the results in a new turn, "hold" attaches them to the user's next message, "cancel" stops the subagent. `
      + 'Do not use native Agent, Task, collaboration or spawn_agent tools, or launch another agent through a shell command.'
    : 'DSH delegation: no delegate tool is available in this session. Do not spawn subagents using native Agent, Task, collaboration or spawn_agent tools, or launch another agent through a shell command. Explain that delegation is unavailable if the task requires a subagent.';
}

export function isNativeSubagentTool(tool: string): boolean {
  return /^(?:Agent|Task|Subagent(?: activity)?|(?:collaboration[./])?(?:spawn_agent|spawnAgent))$/i.test(tool.trim());
}

/** MCP providers expose either the bare tool name or a qualified name. */
export function isDelegationTool(tool: string): boolean {
  return /^(?:(?:mcp[._/]{1,2})?dsh[-_]delegate[._/]{1,2})?delegate_task$/i.test(tool.trim());
}
