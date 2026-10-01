import type { OAuthCliAccount } from './oauthCli';
import type { AccountUsage } from './usageTypes';

/**
 * Claude Code does not currently document a programmatic interface for reading
 * Claude subscription quota windows. Keep this adapter side-effect free until
 * such an interface is available.
 */
export async function readClaudeUsage(account: OAuthCliAccount): Promise<AccountUsage> {
  return {
    status: 'unavailable',
    metrics: [],
    detail: account.provider === 'claude-cli'
      ? 'Claude subscription usage is unavailable through a documented programmatic interface.'
      : 'Usage is available only for Claude accounts.',
    fetchedAt: Date.now(),
  };
}
