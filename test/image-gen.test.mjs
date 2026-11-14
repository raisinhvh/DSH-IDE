import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateImage, imageExtension, imageFileName, imageRequestBody, inputImageProblem, MAX_INPUT_BYTES, parseImageRequest, pngSize } from '../dist/runtime/imageGen.mjs';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test('generates with the ChatGPT sign-in and refreshes once after a 401', async () => {
  const jwt = name => `e30.${Buffer.from(JSON.stringify({ name, exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } })).toString('base64url')}.sig`;
  const home = await mkdtemp(join(tmpdir(), 'dsh-image-'));
  const realFetch = globalThis.fetch;
  try {
    await writeFile(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: jwt('old'), refresh_token: 'r1' } }));
    const fresh = jwt('new');
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), headers: init.headers });
      if (String(url).endsWith('/oauth/token')) return new Response(JSON.stringify({ access_token: fresh, refresh_token: 'r2' }));
      if (init.headers.Authorization !== `Bearer ${fresh}`) return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    };
    const image = await generateImage({ home }, parseImageRequest({ prompt: 'fox' }));
    assert.equal(image.extension, 'png');
    assert.deepEqual(calls.map(call => call.url.split('/').pop()), ['generations', 'token', 'generations']);
    assert.equal(calls[0].headers['ChatGPT-Account-ID'], 'acct-1');
    assert.equal(calls[0].headers.originator, 'codex_cli_rs');
    assert.match(calls[0].headers['User-Agent'], /^codex_cli_rs\/\d+\.\d+\.\d+ /);
    assert.equal(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')).tokens.refresh_token, 'r2');
  } finally {
    globalThis.fetch = realFetch;
    await rm(home, { recursive: true, force: true });
  }
});

test('validates image generation options', () => {
  assert.deepEqual(parseImageRequest({ prompt: '  a red fox  ' }), { prompt: 'a red fox', size: 'auto', quality: 'auto', background: 'auto', images: [] });
  assert.deepEqual(parseImageRequest({ prompt: 'icon', size: '1024x1024', quality: 'low', background: 'transparent' }),
    { prompt: 'icon', size: '1024x1024', quality: 'low', background: 'transparent', images: [] });
  assert.equal(parseImageRequest({}), '"prompt" is required.');
  assert.match(parseImageRequest({ prompt: 'x', size: '4000x4000' }), /"size" must be one of/);
  assert.match(parseImageRequest({ prompt: 'x', quality: 3 }), /"quality" must be one of/);
});

test('accepts up to five input image paths', () => {
  assert.deepEqual(parseImageRequest({ prompt: 'ice version', images: [' art/sword.png ', '.dsh/images/a.png'] }).images, ['art/sword.png', '.dsh/images/a.png']);
  assert.match(parseImageRequest({ prompt: 'x', images: 'a.png' }), /list of file paths/);
  assert.match(parseImageRequest({ prompt: 'x', images: ['a.png', ''] }), /list of file paths/);
  assert.match(parseImageRequest({ prompt: 'x', images: ['1', '2', '3', '4', '5', '6'] }), /at most 5/);
});

test('input images go to the edits endpoint as data URLs', () => {
  const request = parseImageRequest({ prompt: 'ice version', quality: 'low', images: ['a.png'] });
  assert.deepEqual(imageRequestBody(request, []), { url: 'https://chatgpt.com/backend-api/codex/images/generations',
    body: { model: 'gpt-image-2', prompt: 'ice version', size: 'auto', quality: 'low', background: 'auto' } });
  const edit = imageRequestBody(request, [png, Buffer.from([0xff, 0xd8, 0xff, 0xe0])]);
  assert.equal(edit.url, 'https://chatgpt.com/backend-api/codex/images/edits');
  assert.deepEqual(edit.body.images, [{ image_url: `data:image/png;base64,${png.toString('base64')}` }, { image_url: 'data:image/jpeg;base64,/9j/4A==' }]);
  assert.throws(() => imageRequestBody(request, [Buffer.from('GIF89a')]), /not a PNG, JPEG or WebP/);
});

test('rejects input images that are not supported or too large', () => {
  assert.equal(inputImageProblem(png), undefined);
  assert.equal(inputImageProblem(Buffer.from('GIF89a')), 'not a PNG, JPEG or WebP image');
  assert.match(inputImageProblem(Buffer.concat([png, Buffer.alloc(MAX_INPUT_BYTES)])), /larger than 10 MB/);
});

test('names image files from the given name or the prompt', () => {
  const now = new Date(2026, 9, 24, 9, 5, 7);
  assert.equal(imageFileName('Wheat Icon!', 'ignored', 'png', now), 'wheat-icon-20261024-090507.png');
  assert.equal(imageFileName(undefined, 'A golden wheat field at sunset, painterly style', 'png', now), 'a-golden-wheat-field-at-sunset-20261024-090507.png');
  assert.equal(imageFileName('../..', '!!!', 'jpg', now), 'image-20261024-090507.jpg');
});

test('detects image types from their signature', () => {
  assert.equal(imageExtension(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'png');
  assert.equal(imageExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
  assert.equal(imageExtension(Buffer.from('RIFF0000WEBPVP8 ', 'latin1')), 'webp');
  assert.equal(imageExtension(Buffer.from('not an image')), undefined);
});

test('reads PNG dimensions from the header', () => {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(1273, 16);
  header.writeUInt32BE(1236, 20);
  assert.equal(pngSize(header), '1273x1236');
  assert.equal(pngSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), undefined);
});
