import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';

const terminated = new WeakSet<ChildProcessWithoutNullStreams>();

/** Bound the wait for a backend to finish cancelling. */
export function cancellationDeadline(force: () => void, graceMs = 2000): () => void {
  const timer = setTimeout(force, graceMs);
  return () => clearTimeout(timer);
}

/** Descendants can hold stdio open after the CLI exits. */
export function terminateProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (terminated.has(child)) return;
  terminated.add(child);
  if (child.pid && child.exitCode === null) {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { child.kill(); });
      killer.on('close', code => { if (code !== 0) child.kill(); });
      killer.unref();
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { child.kill('SIGKILL'); }
    }
  }
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}
