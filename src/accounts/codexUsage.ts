import type { AccountUsage, AccountUsageMetric } from './usageTypes';
import { chatGptPlan } from './planPrices';
import type { OAuthCliAccount } from './oauthCli';
import { codexHeaders, freshCodexTokens } from './codexAuth';
import type { CodexTokens } from './codexAuth';

type Json = Record<string, unknown>;

// Not a documented public API: the endpoint the Codex CLI reads its ChatGPT rate limits from.
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const TIMEOUT_MS = 12000;

/** Read subscription quota windows straight from ChatGPT with the account's own sign-in. */
export async function readCodexUsage(account: OAuthCliAccount): Promise<AccountUsage> {
  const result = (status: AccountUsage['status'], metrics: AccountUsageMetric[] = [], detail?: string, fix?: AccountUsage['fix']): AccountUsage => ({
    status,
    metrics,
    ...(detail ? { detail } : {}),
    ...(fix ? { fix } : {}),
    fetchedAt: Date.now(),
  });
  if (account.provider !== 'codex-cli') return result('unavailable', [], 'Usage is available only for Codex accounts.');

  let tokens: CodexTokens;
  let response: Response;
  try {
    tokens = await freshCodexTokens(account.directory);
    response = await request(tokens);
    if (response.status === 401) {
      tokens = await freshCodexTokens(account.directory, { force: true });
      response = await request(tokens);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/sign in again/i.test(message)) return result('error', [], 'Codex sign-in has expired. Sign in again to see usage.', 'signin');
    if (error instanceof Error && error.name === 'TimeoutError') return result('error', [], 'Codex usage request timed out.', 'retry');
    return result('error', [], 'Could not read Codex usage. Try again.', 'retry');
  }
  if (response.status === 401 || response.status === 403) return result('error', [], 'Codex sign-in has expired. Sign in again to see usage.', 'signin');
  if (!response.ok) return result('error', [], 'Could not read Codex usage. Try again.', 'retry');

  let body: Json;
  try {
    body = await response.json() as Json;
  } catch {
    return result('error', [], 'Could not read Codex usage. Try again.', 'retry');
  }
  const buckets: [string, unknown][] = [['codex', body.rate_limit]];
  if (Array.isArray(body.additional_rate_limits)) {
    for (const extra of body.additional_rate_limits) {
      if (!isObject(extra)) continue;
      const name = typeof extra.limit_name === 'string' && extra.limit_name.trim() ? extra.limit_name.trim()
        : typeof extra.metered_feature === 'string' ? extra.metered_feature : 'Additional';
      buckets.push([name, extra.rate_limit]);
    }
  }

  const metrics: AccountUsageMetric[] = [];
  for (const [name, limit] of buckets) {
    if (!isObject(limit)) continue;
    for (const key of ['primary_window', 'secondary_window']) {
      const window = limit[key];
      if (!isObject(window)) continue;
      const used = window.used_percent;
      if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) continue;
      const seconds = window.limit_window_seconds;
      const duration = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
        ? formatDuration(Math.round(seconds / 60))
        : key === 'primary_window' ? 'Usage' : 'Additional usage';
      const resetsAt = window.reset_at;
      metrics.push({
        label: `${name === 'codex' ? '' : `${name} · `}${duration}`,
        value: `${used}% used`,
        usedPercent: used,
        ...(typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt: Math.round(resetsAt * 1000) } : {}),
      });
    }
  }
  if (!metrics.length) return result('unavailable', [], 'Codex did not report any usage windows for this account.', 'browser');
  const plan = chatGptPlan(body.plan_type) ?? chatGptPlan(tokens.plan);
  return { ...result('ready', metrics), ...(plan ? { plan } : {}) };
}

function request(tokens: CodexTokens): Promise<Response> {
  return fetch(USAGE_URL, {
    headers: { ...codexHeaders(tokens), Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

function isObject(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function formatDuration(minutes: number): string {
  if (minutes === 300) return '5-hour';
  if (minutes === 10080) return 'Weekly';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
