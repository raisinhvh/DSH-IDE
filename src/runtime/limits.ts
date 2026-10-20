/** Text Claude Code and Codex print when an account has used up its plan's usage window. */
const USAGE_LIMIT = /usage.?limit|usageLimitExceeded|hit your (?:usage |weekly |session )?limit|\blimit (?:reached|exceeded)|rate.?limit|too many requests|\b429\b|insufficient.?quota|out of (?:credits|extra usage)/i;

/** A turn failed because its account is out of usage, so another account of the same provider may still run it. */
export class UsageLimitError extends Error {
  public readonly usageLimit = true;
}

/** The short notice Claude Code sometimes returns as a normal reply, such as "5-hour limit reached ∙ resets 3pm". */
const LIMIT_NOTICE = /^(?:claude(?: ai)? usage limit reached|(?:[\w-]+ )?limit reached\b.*\bresets?\b|you(?:'|’)ve hit your (?:[\w-]+ )?limit\b)/i;

export function isUsageLimitText(text: string): boolean { return USAGE_LIMIT.test(text); }

/** A whole reply that is only a usage-limit notice. Stricter than isUsageLimitText so ordinary replies that mention limits are not mistaken for one. */
export function isLimitNotice(reply: string): boolean { const text = reply.trim(); return text.length <= 200 && LIMIT_NOTICE.test(text); }

export function isUsageLimit(error: unknown): boolean {
  return error instanceof UsageLimitError || (error instanceof Error && isUsageLimitText(error.message));
}
