import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: ['src/accounts/cursorUsage.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { readCursorUsage } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const jwt = exp => `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`;

/** Point the Cursor CLI credential lookup at a temporary folder for every platform. */
async function withAuth(auth, run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cursor-usage-'));
  const saved = { APPDATA: process.env.APPDATA, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  Object.assign(process.env, { APPDATA: root, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root });
  const original = globalThis.fetch;
  try {
    if (auth) for (const dir of ['Cursor', '.cursor', 'cursor']) {
      await mkdir(join(root, dir), { recursive: true });
      await writeFile(join(root, dir, 'auth.json'), JSON.stringify(auth));
    }
    return await run();
  } finally {
    globalThis.fetch = original;
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  }
}

test('Cursor usage maps plan and on-demand usage to billing-cycle metrics', () => withAuth({ accessToken: jwt(Date.now() / 1000 + 3600) }, async () => {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/GetPlanInfo')) return Response.json({ planInfo: { planName: 'Pro', price: '$20/mo' } });
    return Response.json({
      billingCycleEnd: '1795034917000',
      planUsage: { totalPercentUsed: 50.6, autoPercentUsed: 58.4, apiPercentUsed: 42.8 },
      spendLimitUsage: { individualLimit: 2000, individualUsed: 550, limitType: 'user' },
    });
  };
  const usage = await readCursorUsage();
  assert.ok(requests.some(request => request.url === 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage'));
  assert.ok(requests.every(request => /^Bearer x\./.test(request.init.headers.Authorization)));
  assert.equal(usage.status, 'ready');
  assert.deepEqual(usage.plan, { name: 'Pro', monthlyUsd: 20 });
  assert.deepEqual(usage.metrics.map(metric => [metric.label, Math.round(metric.usedPercent), metric.resetsAt]), [
    ['Monthly', 51, 1795034917000], ['Auto + Composer', 58, 1795034917000], ['API models', 43, 1795034917000], ['On-demand', 28, 1795034917000],
  ]);
  assert.equal(usage.metrics[3].value, '$5.50 of $20');
}));

test('Cursor usage asks for sign-in when the token is expired or rejected', async () => {
  await withAuth({ accessToken: jwt(Date.now() / 1000 - 60) }, async () => {
    globalThis.fetch = async () => assert.fail('expired tokens must not be sent');
    const usage = await readCursorUsage();
    assert.equal(usage.fix, 'signin');
  });
  await withAuth({ accessToken: jwt(Date.now() / 1000 + 3600) }, async () => {
    globalThis.fetch = async () => new Response('', { status: 401 });
    assert.equal((await readCursorUsage()).fix, 'signin');
  });
});

test('Cursor usage without stored sign-in points to the browser', () => withAuth(undefined, async () => {
  const usage = await readCursorUsage();
  assert.equal(usage.status, 'unavailable');
  assert.equal(usage.fix, 'browser');
}));
