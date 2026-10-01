import type { AccountUsage } from './usageTypes';

/**
 * Cursor's documented personal CLI/ACP interfaces do not expose subscription
 * quota windows. The documented usage APIs are for team/Enterprise admins and
 * require separate admin credentials, so this adapter intentionally performs
 * no CLI or network request.
 */
export async function readCursorUsage(): Promise<AccountUsage> {
  return {
    status: 'unavailable',
    metrics: [],
    detail: 'Cursor subscription usage is unavailable through the documented personal CLI or ACP interface. Check usage in your Cursor account dashboard.',
    fetchedAt: Date.now(),
  };
}
