import { spawn } from 'node:child_process';
import { constants, setPriority } from 'node:os';

export type ProcessPriority = 'normal' | 'aboveNormal' | 'high';

/** Windows priority class values (PROCESS_PRIORITY_CLASS). */
const PRIORITY_CLASS: Record<ProcessPriority, number> = {
  normal: 0x20,
  aboveNormal: 0x8000,
  high: 0x80,
};

const NODE_PRIORITY: Record<ProcessPriority, number> = {
  normal: constants.priority.PRIORITY_NORMAL,
  aboveNormal: constants.priority.PRIORITY_ABOVE_NORMAL,
  high: constants.priority.PRIORITY_HIGH,
};

let current: ProcessPriority = 'normal';

/** Sets the priority used for agent processes started from now on. */
export function setAgentPriority(value: unknown): void {
  current = value === 'aboveNormal' || value === 'high' ? value : 'normal';
}

export function agentPriority(): ProcessPriority {
  return current;
}

/**
 * Windows does not pass a raised priority class on to child processes, so the shells and tools an agent
 * starts would run at normal priority. A job object with a priority-class limit applies to every process
 * started inside it, so the harness and all of its descendants get the class.
 */
const JOB_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshPriorityJob {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref BasicLimits info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  public static void Apply(int pid, uint priorityClass) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed: " + Marshal.GetLastWin32Error());
    BasicLimits limits = new BasicLimits();
    limits.LimitFlags = 0x20;
    limits.PriorityClass = priorityClass;
    if (!SetInformationJobObject(job, 2, ref limits, (uint)Marshal.SizeOf(typeof(BasicLimits)))) throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
    IntPtr process = OpenProcess(0x0100 | 0x0001 | 0x0200, false, pid);
    if (process == IntPtr.Zero) throw new Exception("OpenProcess failed: " + Marshal.GetLastWin32Error());
    bool assigned = AssignProcessToJobObject(job, process);
    CloseHandle(process);
    if (!assigned) throw new Exception("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error());
  }
}
'@
[DshPriorityJob]::Apply([int]$env:DSH_PRIORITY_PID, [uint32]$env:DSH_PRIORITY_CLASS)
`;

/**
 * Gives a freshly spawned agent harness (and, on Windows, every process it starts) the priority from
 * Settings. Normal priority does nothing. Failures are ignored: priority is a preference, not a requirement.
 */
export function applyAgentPriority(pid: number | undefined): void {
  const priority = current;
  if (!pid || priority === 'normal') return;
  try { setPriority(pid, NODE_PRIORITY[priority]); } catch { /* not allowed on this system */ }
  if (process.platform !== 'win32') return;
  try {
    const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', JOB_SCRIPT], {
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, DSH_PRIORITY_PID: String(pid), DSH_PRIORITY_CLASS: String(PRIORITY_CLASS[priority]) },
    });
    helper.on('error', () => undefined);
  } catch { /* PowerShell missing; the harness itself still has the raised priority */ }
}
