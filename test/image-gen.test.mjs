import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { imageExtension, imageFileName, parseImageRequest, pngSize } from '../dist/runtime/imageGen.mjs';

test('validates image generation options', () => {
  assert.deepEqual(parseImageRequest({ prompt: '  a red fox  ' }), { prompt: 'a red fox', size: 'auto', quality: 'auto', background: 'auto' });
  assert.deepEqual(parseImageRequest({ prompt: 'icon', size: '1024x1024', quality: 'low', background: 'transparent' }),
    { prompt: 'icon', size: '1024x1024', quality: 'low', background: 'transparent' });
  assert.equal(parseImageRequest({}), '"prompt" is required.');
  assert.match(parseImageRequest({ prompt: 'x', size: '4000x4000' }), /"size" must be one of/);
  assert.match(parseImageRequest({ prompt: 'x', quality: 3 }), /"quality" must be one of/);
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
