import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AccountUsage, AccountUsageMetric } from './usageTypes';
import { cursorPlan } from './planPrices';

type Json = Record<string, unknown>;
const EXPIRED = "Cursor's sign-in has expired. Sign in again to see usage.";
const record = (value: unknown): Json | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
/** Connect JSON encodes int64 fields as strings. */
const int = (value: unknown): number => typeof value === 'string' ? Number(value) : finite(value) ? value : NaN;
const dollars = (cents: number): string => `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
const result = (status: AccountUsage['status'], metrics: AccountUsageMetric[] = [], detail?: string, fix?: AccountUsage['fix']): AccountUsage =>
  ({ status, metrics, ...(detail ? { detail } : {}), ...(fix ? { fix } : {}), fetchedAt: Date.now() });

/** Where the Cursor Agent CLI keeps its sign-in (same rules as the CLI's own credential manager). */
function authFile(): string {
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Cursor', 'auth.json');
  if (process.platform === 'darwin') return join(homedir(), '.cursor', 'auth.json');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cursor', 'auth.json');
}

function expiresAt(token: string): number {
  try { return int(record(JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8')))?.exp) * 1000; } catch { return NaN; }
}

/**
 * Read Cursor plan usage for the signed-in Cursor Agent CLI account. Uses Cursor's undocumented
 * dashboard API, so it may stop working if Cursor changes it. Never modifies CLI credentials.
 */
export async function readCursorUsage(): Promise<AccountUsage> {
  let token: unknown;
  try { token = record(JSON.parse(await readFile(authFile(), 'utf8')))?.accessToken; } catch { /* Missing credentials. */ }
  if (typeof token !== 'string' || !token)
    return result('unavailable', [], "DSH can't find Cursor's sign-in on this computer. Check usage in your browser instead.", 'browser');
  const expiry = expiresAt(token);
  if (Number.isFinite(expiry) && expiry <= Date.now()) return result('unavailable', [], EXPIRED, 'signin');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  const call = (method: string): Promise<Response> => fetch(`https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`, {
    method: 'POST', body: '{}', redirect: 'error', signal: controller.signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', Accept: 'application/json' },
  });
  // The plan only weights combined usage, so a failed plan lookup must not hide the usage itself.
  const planInfo = call('GetPlanInfo').then(async response => {
    const info = response.ok ? record(record(await response.json())?.planInfo) : undefined;
    return cursorPlan(info?.planName, info?.price);
  }).catch(() => undefined);
  try {
    const response = await call('GetCurrentPeriodUsage');
    if (response.status === 401 || response.status === 403) return result('unavailable', [], EXPIRED, 'signin');
    if (!response.ok) return result('error', [], 'Could not read Cursor usage. Try again later.', 'retry');
    const text = await response.text();
    if (text.length > 512 * 1024) throw new Error('response too large');
    const data = record(JSON.parse(text));
    if (!data) throw new Error('invalid response');
    const resetsAt = int(data.billingCycleEnd);
    const reset = Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {};
    const metrics: AccountUsageMetric[] = [];
    const add = (label: string, percent: number, value?: string): void => {
      if (Number.isFinite(percent) && percent >= 0) metrics.push({ label, value: value || `${Math.round(percent)}% used`, usedPercent: percent, ...reset });
    };
    const included = record(data.planUsage);
    if (included) {
      add('Monthly', finite(included.totalPercentUsed) ? included.totalPercentUsed : finite(included.includedSpend) && finite(included.limit) && included.limit > 0 ? included.includedSpend / included.limit * 100 : NaN);
      if (finite(included.autoPercentUsed)) add('Auto + Composer', included.autoPercentUsed);
      if (finite(included.apiPercentUsed)) add('API models', included.apiPercentUsed);
    }
    const spend = record(data.spendLimitUsage);
    const limit = finite(spend?.individualLimit) ? spend.individualLimit : NaN;
    const used = finite(spend?.individualUsed) ? spend.individualUsed : 0;
    if (limit > 0) add('On-demand', used / limit * 100, `${dollars(used)} of ${dollars(limit)}`);
    if (!metrics.length) return result('unavailable', [], 'Cursor did not report usage for this account.', 'browser');
    const plan = await planInfo;
    return { ...result('ready', metrics), ...(plan ? { plan } : {}) };
  } catch { return result('error', [], 'Could not read Cursor usage. Try again later.', 'retry'); }
  finally { await planInfo; clearTimeout(timeout); }
}
