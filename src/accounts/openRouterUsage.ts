import type { AccountUsage } from './usageTypes';

const result = (status: AccountUsage['status'], metrics: AccountUsage['metrics'] = [], detail?: string, fix?: AccountUsage['fix']): AccountUsage =>
  ({ status, metrics, ...(detail ? { detail } : {}), ...(fix ? { fix } : {}), fetchedAt: Date.now() });
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Read OpenRouter key spending. */
export async function readOpenRouterUsage(apiKey: string): Promise<AccountUsage> {
  if (typeof apiKey !== 'string' || !apiKey.trim()) return result('error', [], 'Add an OpenRouter API key in account settings to read usage.', 'key');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/key', {
      method: 'GET', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, redirect: 'error', signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) return result('error', [], 'OpenRouter rejected this API key. Replace it to see usage.', 'key');
    if (!response.ok) throw new Error('request failed');
    const reader = response.body?.getReader(); if (!reader) throw new Error('empty response');
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.byteLength; if (length > 32 * 1024) { await reader.cancel(); throw new Error('response too large'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const body = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    const payload = JSON.parse(new TextDecoder().decode(body));
    const data = payload?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid response');
    const usage = finite(data.usage) ? data.usage : 0;
    const metrics: AccountUsage['metrics'] = finite(data.limit) && data.limit > 0
      ? [{ label: 'Credit limit', value: `$${usage.toFixed(2)} of $${data.limit.toFixed(2)}`, usedPercent: usage / data.limit * 100 }]
      : [{ label: 'Spent', value: `$${usage.toFixed(2)}` }];
    if (finite(data.usage_monthly)) metrics.push({ label: 'This month', value: `$${data.usage_monthly.toFixed(2)}` });
    return result('ready', metrics);
  } catch { return result('error', [], 'Could not read OpenRouter usage. Check your connection and try again.', 'retry'); }
  finally { clearTimeout(timeout); }
}
