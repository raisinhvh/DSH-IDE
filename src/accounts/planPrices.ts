import type { AccountPlan } from './usageTypes';

/** US list prices per month. Plans missing here (enterprise, custom) are left unpriced. */
const CHATGPT: Record<string, AccountPlan> = {
  free: { name: 'Free', monthlyUsd: 0 },
  go: { name: 'Go', monthlyUsd: 8 },
  plus: { name: 'Plus', monthlyUsd: 20 },
  pro: { name: 'Pro', monthlyUsd: 200 },
  team: { name: 'Business', monthlyUsd: 30 },
  business: { name: 'Business', monthlyUsd: 30 },
};

export function chatGptPlan(planType: unknown): AccountPlan | undefined {
  return typeof planType === 'string' ? CHATGPT[planType.toLowerCase()] : undefined;
}

export function claudePlan(subscriptionType: unknown, rateLimitTier: unknown): AccountPlan | undefined {
  const tier = typeof rateLimitTier === 'string' ? rateLimitTier : '';
  switch (subscriptionType) {
    case 'pro': return { name: 'Pro', monthlyUsd: 20 };
    case 'max': return /20x/.test(tier) ? { name: 'Max 20x', monthlyUsd: 200 } : { name: 'Max 5x', monthlyUsd: 100 };
    case 'team': return { name: 'Team', monthlyUsd: 30 };
    default: return undefined;
  }
}

/** Cursor reports prices as display text such as "$20/mo". */
export function cursorPlan(name: unknown, price: unknown): AccountPlan | undefined {
  const amount = typeof price === 'string' ? Number(/^\$(\d+(?:\.\d+)?)\s*\/\s*mo/i.exec(price.trim())?.[1]) : NaN;
  return typeof name === 'string' && name && Number.isFinite(amount) ? { name, monthlyUsd: amount } : undefined;
}
