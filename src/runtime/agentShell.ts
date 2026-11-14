import { rustToolsInstructions, withRustTools } from './rustTools';

/**
 * Settings for the shells agents run commands in. Each harness spawn passes its environment through agentEnv,
 * and the instructions text joins the agent's system instructions.
 */

let powershellSpeedups = true;

export function setPowershellSpeedups(enabled: unknown): void {
  powershellSpeedups = enabled !== false;
}

/** Environment for a harness process: rg/fd/sd on PATH when installed, and PowerShell startup without telemetry or update checks. */
export function agentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = withRustTools(env);
  if (!powershellSpeedups) return result;
  return { ...result, POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off', POWERSHELL_CLI_TELEMETRY_OPTOUT: '1' };
}

export const POWERSHELL_SPEEDUPS = [
  'PowerShell speed:',
  '- Never grow an array or string with += in a loop (it copies everything each time). Collect loop output with $items = foreach (...) { ... }, or use [System.Collections.Generic.List[object]] and .Add(); join text with -join.',
  '- Run independent slow work in parallel: ForEach-Object -Parallel -ThrottleLimit 8 in PowerShell 7; in 5.1, Start-ThreadJob when the ThreadJob module exists, otherwise Start-Job, then Receive-Job -Wait -AutoRemoveJob.',
  '- Set $ProgressPreference = \'SilentlyContinue\' before Invoke-WebRequest, Expand-Archive or large copies; the progress bar makes them many times slower.',
  '- Filter at the source (Get-ChildItem -Filter, -Include, native rg/fd) instead of piping everything to Where-Object; read large files with [IO.File]::ReadAllLines or Get-Content -ReadCount 0.',
  '- Discard output with $null = ... instead of | Out-Null, and start child PowerShells with -NoProfile.',
].join('\n');

/** Background servers and watchers keep a harness waiting after its answer, so the turn never ends. */
export const BACKGROUND_CLEANUP = 'Stop servers, watchers and other background commands you started (KillShell, TaskStop or kill the process) before ending the turn, unless the user asked to keep them running.';

/** Shell guidance for agents, following the current settings. */
export function shellInstructions(): string {
  return [rustToolsInstructions(), powershellSpeedups && process.platform === 'win32' ? POWERSHELL_SPEEDUPS : ''].filter(Boolean).join('\n');
}
