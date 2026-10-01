import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parseRelease, latestExtensionRelease, installExtensionRelease } from '../dist/update/extensionUpdate.mjs';

const repository = 'example/dsh-releases';
const downloadUrl = `https://github.com/${repository}/releases/download/v5.0.1/dsh-ide-5.0.1.vsix`;
const release = { tag_name: 'v5.0.1', assets: [{ name: 'dsh-ide-5.0.1.vsix', browser_download_url: downloadUrl }] };

test('offers only newer stable releases with a matching VSIX from the configured repository', () => {
  assert.deepEqual(parseRelease(release, repository, '4.8.9'), { version: '5.0.1', downloadUrl, digest: undefined });
  for (const current of ['5.0.1', '5.0.2', '6.0.0']) assert.equal(parseRelease(release, repository, current), undefined);
  for (const change of [{ draft: true }, { prerelease: true }, { tag_name: 'invalid' }, { assets: [] },
    { assets: [{ name: 'another-extension.vsix', browser_download_url: downloadUrl }] },
    { assets: [{ name: 'dsh-ide-5.0.1.vsix', browser_download_url: 'invalid' }] },
    { assets: [{ name: 'dsh-ide-5.0.1.vsix', browser_download_url: 'https://evil.example/file.vsix' }] }]) {
    assert.equal(parseRelease({ ...release, ...change }, repository, '4.8.9'), undefined);
  }
  assert.ok(parseRelease({ ...release, tag_name: '5.0.1' }, repository, '5.0.1-rc.1'));
});

test('checks the latest release API and handles an empty repository', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, `https://api.github.com/repos/${repository}/releases/latest`);
    return Response.json(release);
  });
  assert.equal((await latestExtensionRelease(repository, '4.8.9')).version, '5.0.1');
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  assert.equal(await latestExtensionRelease(repository, '4.8.9'), undefined);
  await assert.rejects(latestExtensionRelease('https://github.com/example/repo', '4.8.9'), /owner\/repository/);
});

test('downloads before installing and removes temporary files on success or failure', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('test-vsix'));
  let installedPath;
  await installExtensionRelease({ version: '5.0.1', downloadUrl }, async path => {
    installedPath = path;
    assert.equal(await readFile(path, 'utf8'), 'test-vsix');
  });
  assert.equal(existsSync(installedPath), false);
  await assert.rejects(installExtensionRelease({ version: '5.0.1', downloadUrl }, async path => {
    installedPath = path;
    throw new Error('host rejected package');
  }), /host rejected/);
  assert.equal(existsSync(installedPath), false);
  await assert.rejects(installExtensionRelease({ version: '5.0.1', downloadUrl, digest: 'sha256:wrong' }, async () => {
    assert.fail('a corrupt download must never be installed');
  }), /checksum/);
});
