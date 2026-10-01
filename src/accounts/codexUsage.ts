import { spawn } from 'node:child_process';
import type { AccountUsage, AccountUsageMetric } from './usageTypes';
import { cliCommand, cliEnv } from './oauthCli';
import type { OAuthCliAccount } from './oauthCli';

type Json = Record<string, unknown>;

const TIMEOUT_MS = 12000;
const MAX_OUTPUT = 256 * 1024;
const MAX_LINE = 64 * 1024;

/** Read subscription quota data through Codex's documented app-server RPC. */
export async function readCodexUsage(account: OAuthCliAccount): Promise<AccountUsage> {
  const result = (status: AccountUsage['status'], metrics: AccountUsageMetric[] = [], detail?: string): AccountUsage => ({
    status, metrics, ...(detail ? { detail } : {}), fetchedAt: Date.now(),
  });
  if (account.provider !== 'codex-cli') return result('unavailable', [], 'Usage is available only for Codex accounts.');

  let child: ReturnType<typeof spawn> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let done = false;
  let totalOutput = 0;
  let buffer = '';
  let nextId = 1;
  const pending = new Map<number, { resolve(value: Json): void; reject(error: Error): void }>();
  let waitForClose: (() => Promise<void>) | undefined;

  const failPending = (message: string): void => {
    for (const call of pending.values()) call.reject(new Error(message));
    pending.clear();
  };

  try {
    child = spawn(cliCommand('codex-cli'), ['app-server', '--listen', 'stdio://'], {
      env: cliEnv(account), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const process = child as import('node:child_process').ChildProcessWithoutNullStreams;
    waitForClose = () => new Promise(resolve => {
      if (process.exitCode !== null || process.signalCode !== null) { resolve(); return; }
      let settled = false;
      const closeTimer = setTimeout(() => finish(), 750);
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(closeTimer);
        resolve();
      };
      process.once('close', finish);
    });
    process.stdout.setEncoding('utf8');
    process.stderr.resume(); // Drain, but never retain or expose diagnostic output.
    process.stdin.on('error', () => failPending('Codex app-server request failed.'));

    const rpc = (method: string, params?: Json): Promise<Json> => new Promise((resolve, reject) => {
      if (done || !process.stdin.writable) { reject(new Error('Codex app-server is unavailable.')); return; }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      process.stdin.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + '\n', error => {
        if (!error) return;
        pending.delete(id);
        reject(new Error('Codex app-server request failed.'));
      });
    });

    process.stdout.on('data', (chunk: string) => {
      totalOutput += Buffer.byteLength(chunk, 'utf8');
      if (totalOutput > MAX_OUTPUT) {
        failPending('Codex app-server response was too large.');
        process.kill();
        return;
      }
      buffer += chunk;
      if (buffer.length > MAX_LINE && !buffer.includes('\n')) {
        failPending('Codex app-server response was too large.');
        process.kill();
        return;
      }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line || line.length > MAX_LINE) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const message = parsed as Json;
        if (typeof message.id !== 'number') continue;
        const call = pending.get(message.id);
        if (!call) continue;
        pending.delete(message.id);
        if (message.error) call.reject(new Error('Codex app-server rejected the request.'));
        else call.resolve(message.result && typeof message.result === 'object' ? message.result as Json : {});
      }
    });
    process.on('error', () => failPending('Codex app-server could not start. Check the Codex CLI path in Settings.'));
    process.on('close', () => failPending('Codex app-server exited before returning usage.'));

    timer = setTimeout(() => {
      failPending('Codex app-server request timed out.');
      process.kill();
    }, TIMEOUT_MS);

    await rpc('initialize', {
      clientInfo: { name: 'dsh-ide', title: 'DSH IDE', version: '0.4.6' }, capabilities: null,
    });
    process.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const response = await rpc('account/rateLimits/read');
    const root = response.rateLimits && typeof response.rateLimits === 'object' ? response.rateLimits as Json : undefined;
    const byId = response.rateLimitsByLimitId && typeof response.rateLimitsByLimitId === 'object'
      ? Object.entries(response.rateLimitsByLimitId as Json) : [];
    const buckets = byId.length ? byId
      : root ? [[typeof root.limitId === 'string' ? root.limitId : 'codex', root] as [string, unknown]] : [];

    const metrics: AccountUsageMetric[] = [];
    for (const [id, raw] of buckets) {
      if (!raw || typeof raw !== 'object') continue;
      const bucket = raw as Json;
      const name = typeof bucket.limitName === 'string' && bucket.limitName.trim() ? bucket.limitName.trim() : id;
      for (const key of ['primary', 'secondary']) {
        const window = bucket[key];
        if (!window || typeof window !== 'object') continue;
        const quota = window as Json;
        const used = quota.usedPercent;
        if (typeof used !== 'number' || !Number.isFinite(used)) continue;
        const minutes = quota.windowDurationMins;
        const duration = typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? ` (${formatDuration(minutes)})` : '';
        const label = `${name === 'codex' ? 'Codex' : name}${duration || (key === 'primary' ? ' usage' : ' additional usage')}`;
        const seconds = quota.resetsAt;
        if (used < 0) continue;
        metrics.push({ label, value: `${used}% used`, usedPercent: used,
          ...(typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? { resetsAt: Math.round(seconds * 1000) } : {}) });
      }
    }
    if (!metrics.length) return result('unavailable', [], 'Codex did not report any usage windows for this account.');
    return result('ready', metrics);
  } catch (error) {
    const detail = error instanceof Error && error.message.includes('timed out')
      ? 'Codex usage request timed out. Try again shortly.'
      : error instanceof Error && error.message.includes('could not start')
        ? 'Codex CLI could not start. Check its path in Settings.'
        : 'Codex usage is unavailable. Check that this account is signed in with ChatGPT.';
    return result('error', [], detail);
  } finally {
    done = true;
    if (timer) clearTimeout(timer);
    if (child && !child.killed) child.kill();
    failPending('Codex app-server connection closed.');
    if (waitForClose) await waitForClose();
  }
}

function formatDuration(minutes: number): string {
  if (minutes === 10080) return 'Weekly';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
