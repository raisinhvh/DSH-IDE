import type { OAuthCliAccount } from './oauthCli';
import type { AccountUsage } from './usageTypes';
import { readClaudeUsage, claudeEventMetric } from './claudeUsage';
import { readCodexUsage } from './codexUsage';
import { readDeepSeekUsage } from './deepseekUsage';
import { readOpenRouterUsage } from './openRouterUsage';

export type UsageEntry = AccountUsage & { loading?: boolean };
export interface UsageTarget { id: string; provider: string; oauth?: OAuthCliAccount; secret?: () => Promise<string | undefined> }

export class AccountUsageService {
  private usage: Record<string, UsageEntry> = {};
  private readonly inFlight = new Map<string, Promise<void>>();
  private emitPending = false;
  constructor(private readonly onChange: (usage: Record<string, UsageEntry>) => void) {}

  snapshot(): Record<string, UsageEntry> { return { ...this.usage }; }

  private emit(): void {
    if (this.emitPending) return;
    this.emitPending = true;
    queueMicrotask(() => { this.emitPending = false; this.onChange(this.snapshot()); });
  }

  /** Refreshes targets and removes entries for accounts no longer present. */
  async refresh(targets: UsageTarget[], force = false): Promise<void> {
    const ids = new Set(targets.map(target => target.id));
    let changed = false;
    for (const id of Object.keys(this.usage)) if (!ids.has(id)) { delete this.usage[id]; changed = true; }
    if (changed) this.emit();
    await Promise.all(targets.map(target => this.refreshOne(target, force)));
  }

  refreshOne(target: UsageTarget, force = false): Promise<void> {
    const pending = this.inFlight.get(target.id);
    if (pending) return pending;
    const previous = this.usage[target.id];
    if (!force && previous && Date.now() - previous.fetchedAt < 60_000) return Promise.resolve();
    this.usage[target.id] = { ...(previous || { status: 'unavailable', metrics: [], fetchedAt: 0 }), loading: true };
    this.emit();
    const task = (async () => {
      let result: AccountUsage;
      try {
        const missing = (): AccountUsage => ({ status: 'error', metrics: [], detail: 'Account details are missing.', fetchedAt: Date.now() });
        if (target.provider === 'claude-cli' || target.provider === 'codex-cli') {
          result = !target.oauth ? missing() : target.provider === 'claude-cli' ? await readClaudeUsage(target.oauth) : await readCodexUsage(target.oauth);
        } else if (target.provider === 'deepseek-official' || target.provider === 'openrouter') {
          const secret = await target.secret?.();
          result = !secret ? missing() : target.provider === 'deepseek-official' ? await readDeepSeekUsage(secret) : await readOpenRouterUsage(secret);
        } else result = { status: 'unavailable', metrics: [], detail: 'This provider does not report usage to DSH yet.', fetchedAt: Date.now() };
      } catch { result = { status: 'error', metrics: [], detail: 'Could not read account usage. Try again later.', fetchedAt: Date.now() }; }
      if (this.usage[target.id]) { this.usage[target.id] = result; this.emit(); }
    })();
    this.inFlight.set(target.id, task);
    void task.finally(() => { if (this.inFlight.get(target.id) === task) this.inFlight.delete(target.id); });
    return task;
  }

  /** Merge a Claude rate limit update into cached usage. */
  applyClaudeEvent(accountId: string, info: unknown): void {
    const metric = claudeEventMetric(info); if (!metric) return;
    const metrics = [...(this.usage[accountId]?.metrics || [])];
    const index = metrics.findIndex(item => item.label === metric.label);
    if (index < 0) metrics.push(metric); else metrics[index] = metric;
    this.usage[accountId] = { status: 'ready', metrics, fetchedAt: Date.now(), ...(this.inFlight.has(accountId) ? { loading: true } : {}) };
    this.emit();
  }
}
