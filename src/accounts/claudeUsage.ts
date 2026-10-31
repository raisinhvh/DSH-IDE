import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OAuthCliAccount } from './oauthCli';
import type { AccountUsage, AccountUsageMetric } from './usageTypes';

type Json = Record<string, unknown>;
const RENEWING = "Sign-in is renewing. Usage updates after this account's next Claude turn.";
const record = (value: unknown): Json | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const title = (value: string): string => value.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const result = (status: AccountUsage['status'], metrics: AccountUsageMetric[] = [], detail?: string): AccountUsage =>
  ({ status, metrics, ...(detail ? { detail } : {}), fetchedAt: Date.now() });
const labels: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly', seven_day_opus: 'Weekly · Opus', seven_day_sonnet: 'Weekly · Sonnet' };

function metric(label: string, percent: unknown, reset: unknown): AccountUsageMetric | undefined {
  if (!finite(percent) || percent < 0) return undefined;
  const resetsAt = typeof reset === 'string' ? Date.parse(reset) : NaN;
  return { label, value: `${Math.round(percent)}% used`, usedPercent: percent, ...(Number.isFinite(resetsAt) ? { resetsAt } : {}) };
}

/** Map a Claude stream rate limit update to a usage metric. */
export function claudeEventMetric(info: unknown): AccountUsageMetric | undefined {
  const data = record(info);
  if (!data || typeof data.rateLimitType !== 'string') return undefined;
  const raw = data.utilization;
  const percent = finite(raw) ? (raw <= 1 ? raw * 100 : raw) : data.status === 'rejected' ? 100 : NaN;
  const mapped = metric(labels[data.rateLimitType] || title(data.rateLimitType), percent, undefined);
  if (mapped && finite(data.resetsAt)) mapped.resetsAt = data.resetsAt * 1000;
  return mapped;
}

/** Read Claude subscription usage without modifying CLI credentials. */
export async function readClaudeUsage(account: OAuthCliAccount): Promise<AccountUsage> {
  if (account.provider !== 'claude-cli') return result('unavailable', [], 'Usage is available only for Claude accounts.');
  let credentials: Json | undefined;
  try { credentials = record(record(JSON.parse(await readFile(join(account.directory, '.credentials.json'), 'utf8')))?.claudeAiOauth); } catch { /* Missing credentials. */ }
  if (!credentials || typeof credentials.accessToken !== 'string' || !credentials.accessToken || !finite(credentials.expiresAt))
    return result('unavailable', [], 'Sign in again to see usage.');
  if (credentials.expiresAt <= Date.now()) return result('unavailable', [], RENEWING);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET', headers: { Authorization: `Bearer ${credentials.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
      redirect: 'error', signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) return result('unavailable', [], RENEWING);
    if (!response.ok) return result('error', [], 'Could not read Claude usage. Try again later.');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('empty response');
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.byteLength; if (length > 64 * 1024) { await reader.cancel(); throw new Error('response too large'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const body = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    const data = record(JSON.parse(new TextDecoder().decode(body)));
    if (!data) throw new Error('invalid response');
    const metrics: AccountUsageMetric[] = [];
    const add = (item: AccountUsageMetric | undefined): void => { if (item) metrics.push(item); };
    if (Array.isArray(data.limits) && data.limits.length) {
      for (const raw of data.limits) {
        const item = record(raw); if (!item || typeof item.kind !== 'string') continue;
        const scope = record(item.scope); const model = record(scope?.model);
        const name = typeof model?.display_name === 'string' && model.display_name || typeof scope?.surface === 'string' && scope.surface || 'scoped';
        const label = item.kind === 'session' ? '5-hour' : item.kind === 'weekly_all' ? 'Weekly'
          : item.kind === 'weekly_scoped' ? `Weekly · ${name}` : item.kind.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
        add(metric(label, item.percent, item.resets_at));
      }
    } else {
      for (const [key, label] of Object.entries(labels)) {
        const item = record(data[key]); if (item) add(metric(label, item.utilization, item.resets_at));
      }
    }
    const extra = record(data.extra_usage);
    if (extra?.is_enabled === true && finite(extra.monthly_limit) && finite(extra.used_credits)) {
      const divisor = finite(extra.decimal_places) ? 10 ** extra.decimal_places : 1;
      const limit = extra.monthly_limit / divisor; const used = extra.used_credits / divisor;
      const percent = finite(extra.utilization) ? extra.utilization : used / limit * 100;
      metrics.push({ label: 'Extra usage', value: `${used} of ${limit}${typeof extra.currency === 'string' && extra.currency ? ` ${extra.currency}` : ''}`,
        ...(Number.isFinite(percent) ? { usedPercent: percent } : {}) });
    }
    return metrics.length ? result('ready', metrics) : result('unavailable', [], 'Claude did not report any usage windows for this account.');
  } catch { return result('error', [], 'Could not read Claude usage. Try again later.'); }
  finally { clearTimeout(timeout); }
}
