import type { AccountUsage } from './usageTypes';

const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 32 * 1024;
const DETAIL = 'DeepSeek reports account balance, not 5h, weekly, or monthly used quota.';

interface BalanceInfo {
  currency: 'CNY' | 'USD';
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
}

interface BalanceResponse {
  is_available: boolean;
  balance_infos: BalanceInfo[];
}

function result(status: AccountUsage['status'], metrics: AccountUsage['metrics'] = [], detail?: string): AccountUsage {
  return { status, metrics, ...(detail ? { detail } : {}), fetchedAt: Date.now() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMoney(value: unknown): value is string {
  // API monetary values are decimal strings. Reject signs, exponents, NaN, and
  // whitespace so rendering cannot accidentally imply a valid balance.
  return typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}

function parseResponse(value: unknown): BalanceResponse | undefined {
  if (!isRecord(value) || typeof value.is_available !== 'boolean' || !Array.isArray(value.balance_infos)) return undefined;
  const seen = new Set<string>();
  const balanceInfos: BalanceInfo[] = [];
  for (const entry of value.balance_infos) {
    if (!isRecord(entry)
      || (entry.currency !== 'CNY' && entry.currency !== 'USD')
      || !isMoney(entry.total_balance)
      || !isMoney(entry.granted_balance)
      || !isMoney(entry.topped_up_balance)
      || seen.has(entry.currency)) return undefined;
    seen.add(entry.currency);
    balanceInfos.push({
      currency: entry.currency,
      total_balance: entry.total_balance,
      granted_balance: entry.granted_balance,
      topped_up_balance: entry.topped_up_balance,
    });
  }
  return { is_available: value.is_available, balance_infos: balanceInfos };
}

async function readBoundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('response-too-large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(body);
}

export async function readDeepSeekUsage(apiKey: string): Promise<AccountUsage> {
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    return result('error', [], 'Add a DeepSeek API key in account settings to read its balance.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(BALANCE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) return result('error', [], 'Could not read DeepSeek balance. Check the API key and try again.');

    let payload: unknown;
    try {
      payload = JSON.parse(await readBoundedBody(response));
    } catch {
      return result('error', [], 'DeepSeek returned an invalid balance response. Try again later.');
    }
    const data = parseResponse(payload);
    if (!data) return result('error', [], 'DeepSeek returned an invalid balance response. Try again later.');

    const metrics: AccountUsage['metrics'] = [];
    for (const info of data.balance_infos) {
      metrics.push({ label: `Available balance (${info.currency})`, value: `${info.total_balance} ${info.currency}` });
      metrics.push({ label: `Granted balance (${info.currency})`, value: `${info.granted_balance} ${info.currency}` });
      metrics.push({ label: `Topped-up balance (${info.currency})`, value: `${info.topped_up_balance} ${info.currency}` });
    }
    if (metrics.length === 0) {
      return result('unavailable', [], 'DeepSeek did not report a balance for this account. ' + DETAIL);
    }
    return result(data.is_available ? 'ready' : 'unavailable', metrics, DETAIL);
  } catch {
    return result('error', [], controller.signal.aborted
      ? 'DeepSeek balance request timed out. Check your connection and try again.'
      : 'Could not reach DeepSeek balance service. Check your connection and try again.');
  } finally {
    clearTimeout(timeout);
  }
}
