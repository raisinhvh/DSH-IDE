/** Provider-reported account usage. Never contains authentication data. */
export interface AccountUsageMetric {
  label: string;
  value: string;
  usedPercent?: number;
  resetsAt?: number;
}

/** What the user can do to get usage working again; the sidebar shows a matching button. */
export type UsageFix = 'retry' | 'signin' | 'key' | 'cli' | 'browser';

export interface AccountUsage {
  status: 'ready' | 'unavailable' | 'error';
  metrics: AccountUsageMetric[];
  detail?: string;
  fix?: UsageFix;
  fetchedAt: number;
}
