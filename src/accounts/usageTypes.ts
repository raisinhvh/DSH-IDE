/** Provider-reported account usage. Never contains authentication data. */
export interface AccountUsageMetric {
  label: string;
  value: string;
  usedPercent?: number;
  resetsAt?: number;
}

export interface AccountUsage {
  status: 'ready' | 'unavailable' | 'error';
  metrics: AccountUsageMetric[];
  detail?: string;
  fetchedAt: number;
}
