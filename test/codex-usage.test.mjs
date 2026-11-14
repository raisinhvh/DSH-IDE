import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const bundled = await build({
  stdin: { contents: "export * from './src/accounts/codexUsage.ts'; export * from './src/accounts/codexAuth.ts';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { readCodexUsage, readCodexTokens, freshCodexTokens, codexHeaders } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

const jwt = claims => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const accessToken = (name, expiresInSeconds, extra = {}) => jwt({
  exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  name,
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'pro', ...extra },
  'https://api.openai.com/profile': { email: 'person@example.com' },
});

async function profile(access, extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-codex-'));
  await writeFile(join(home, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { id_token: jwt({ email: 'id@example.com' }), access_token: access, refresh_token: 'refresh-1', account_id: 'acct-1', login_owner_id: 'keep-me' },
    last_refresh: '2026-01-01T00:00:00Z',
    ...extra,
  }));
  return home;
}

/** Replaces fetch: the token endpoint issues `refreshed`; usage answers with `usage(request)`. */
function mockFetch({ usage, refreshed = accessToken('new', 3600), tokenStatus = 200 }) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === 'https://auth.openai.com/oauth/token') {
      return new Response(JSON.stringify({ access_token: refreshed, refresh_token: 'refresh-2', id_token: jwt({ email: 'id@example.com' }) }), { status: tokenStatus });
    }
    const { status = 200, body } = usage(init);
    return new Response(JSON.stringify(body ?? {}), { status });
  };
  return calls;
}

const usageBody = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1730947200 },
    secondary_window: { used_percent: 70, limit_window_seconds: 604800 },
  },
  additional_rate_limits: [
    { limit_name: 'Extra', rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 3600, reset_at: 1730948000 }, secondary_window: null } },
    { limit_name: 'Missing', rate_limit: { primary_window: { used_percent: null } } },
  ],
};

test('Codex usage reads ChatGPT quota windows with the account headers', async () => {
  const home = await profile(accessToken('old', 3600));
  try {
    const calls = mockFetch({ usage: () => ({ body: usageBody }) });
    const usage = await readCodexUsage({ id: 'codex:test', provider: 'codex-cli', label: 'Test', directory: home });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(calls[0].init.headers['ChatGPT-Account-ID'], 'acct-1');
    assert.equal(calls[0].init.headers.originator, 'codex_cli_rs');
    assert.match(calls[0].init.headers.Authorization, /^Bearer /);
    assert.equal(usage.status, 'ready');
    assert.deepEqual(usage.metrics.map(metric => metric.label), ['5-hour', 'Weekly', 'Extra · 1h']);
    assert.equal(usage.metrics[0].usedPercent, 25);
    assert.equal(usage.metrics[0].resetsAt, 1730947200000);
    assert.equal(usage.metrics[1].resetsAt, undefined);
    assert.equal(usage.plan.name, 'Plus');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('Codex usage rejects non-Codex profiles without a request', async () => {
  const calls = mockFetch({ usage: () => ({ body: usageBody }) });
  const usage = await readCodexUsage({ id: 'other', provider: 'claude-cli', label: 'Other', directory: 'profile' });
  assert.equal(usage.status, 'unavailable');
  assert.equal(calls.length, 0);
});

test('Codex usage refreshes once after a 401 and rewrites auth.json in the CLI format', async () => {
  const home = await profile(accessToken('old', 3600));
  try {
    const refreshed = accessToken('new', 3600);
    const calls = mockFetch({ refreshed, usage: init => init.headers.Authorization === `Bearer ${refreshed}` ? { body: usageBody } : { status: 401 } });
    const usage = await readCodexUsage({ id: 'codex:test', provider: 'codex-cli', label: 'Test', directory: home });
    assert.equal(usage.status, 'ready');
    assert.deepEqual(calls.map(call => call.url.split('/').pop()), ['usage', 'token', 'usage']);
    const saved = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'));
    assert.equal(saved.auth_mode, 'chatgpt');
    assert.equal(saved.OPENAI_API_KEY, null);
    assert.equal(saved.tokens.access_token, refreshed);
    assert.equal(saved.tokens.refresh_token, 'refresh-2');
    assert.equal(saved.tokens.account_id, 'acct-1');
    assert.equal(saved.tokens.login_owner_id, 'keep-me');
    assert.ok(Date.parse(saved.last_refresh) > Date.parse('2026-01-02'));
    assert.deepEqual(await readdir(home), ['auth.json']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('Codex usage asks for sign-in when the refresh token is rejected or auth.json is missing', async () => {
  const home = await profile(accessToken('old', 60));
  try {
    mockFetch({ tokenStatus: 401, usage: () => ({ body: usageBody }) });
    const expired = await readCodexUsage({ id: 'codex:test', provider: 'codex-cli', label: 'Test', directory: home });
    assert.equal(expired.fix, 'signin');
    assert.equal(expired.detail, 'Codex sign-in has expired. Sign in again to see usage.');
    const missing = await readCodexUsage({ id: 'codex:test', provider: 'codex-cli', label: 'Test', directory: join(home, 'none') });
    assert.equal(missing.fix, 'signin');
    mockFetch({ usage: () => ({ status: 503 }) });
    await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: accessToken('fresh', 3600), refresh_token: 'r' } }));
    const busy = await readCodexUsage({ id: 'codex:test', provider: 'codex-cli', label: 'Test', directory: home });
    assert.equal(busy.fix, 'retry');
    assert.equal(busy.detail, 'Could not read Codex usage. Try again.');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('Codex tokens come from auth.json claims and concurrent refreshes share one request', async () => {
  const home = await profile(accessToken('old', 60, { chatgpt_account_is_fedramp: true }));
  try {
    const tokens = await readCodexTokens(home);
    assert.equal(tokens.accountId, 'acct-1');
    assert.equal(tokens.plan, 'pro');
    assert.equal(tokens.email, 'id@example.com');
    assert.equal(tokens.fedramp, true);
    assert.equal(codexHeaders(tokens)['X-OpenAI-Fedramp'], 'true');
    assert.ok(Math.abs(tokens.expires - (Date.now() + 60000)) < 5000);
    const calls = mockFetch({ usage: () => ({ body: usageBody }) });
    const [first, second] = await Promise.all([freshCodexTokens(home), freshCodexTokens(home)]);
    assert.equal(calls.length, 1);
    assert.equal(first.access, second.access);
    assert.equal(first.refresh, 'refresh-2');
    const again = await freshCodexTokens(home);
    assert.equal(calls.length, 1);
    assert.equal(again.access, first.access);
    await assert.rejects(readCodexTokens(join(home, 'none')), /Sign in again in Accounts\.$/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
