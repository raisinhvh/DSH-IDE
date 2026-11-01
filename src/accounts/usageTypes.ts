/** Provider-reported account usage. Never contains authentication data. */
export interface AccountUsageMetric {
  label: string;
  value: string;
  usedPercent?: number;
  resetsAt?: number;
}

/** What the user can do to get usage working again; the sidebar shows a matching button. */
export type UsageFix = 'retry' | 'signin' | 'key' | 'cli' | 'browser';

/** The subscription behind an account; its price weights the account in combined usage. */
export interface AccountPlan {
  name: string;
  monthlyUsd: number;
}

export interface AccountUsage {
  status: 'ready' | 'unavailable' | 'error';
  metrics: AccountUsageMetric[];
  detail?: string;
  fix?: UsageFix;
  plan?: AccountPlan;
  fetchedAt: number;
}
