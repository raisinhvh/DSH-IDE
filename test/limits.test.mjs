import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isLimitNotice, isUsageLimit, isUsageLimitText, UsageLimitError } from '../dist/runtime/limits.mjs';

test('recognizes Claude and Codex usage limit errors', () => {
  assert.ok(isUsageLimitText('Claude AI usage limit reached|1760000000'));
  assert.ok(isUsageLimitText("You've hit your usage limit. Upgrade to Pro or try again later."));
  assert.ok(isUsageLimitText('stream error: usageLimitExceeded'));
  assert.ok(isUsageLimitText('API Error: 429 Too Many Requests'));
  assert.ok(isUsageLimit(new UsageLimitError('spent')));
  assert.ok(isUsageLimit(new Error('Codex turn failed. rate_limit_exceeded')));
  assert.ok(!isUsageLimit(new Error('Claude Code exited with code 1. Sign in again from Accounts.')));
});

test('treats a reply as a limit notice only when it is nothing but the notice', () => {
  assert.ok(isLimitNotice('5-hour limit reached ∙ resets 3pm'));
  assert.ok(isLimitNotice("You've hit your limit · resets 3pm (Europe/London)"));
  assert.ok(isLimitNotice('Claude AI usage limit reached|1760000000'));
  assert.ok(!isLimitNotice('I fixed the rate limit bug in the uploader.'));
  assert.ok(!isLimitNotice(`5-hour limit reached ∙ resets 3pm ${'x'.repeat(300)}`));
});
