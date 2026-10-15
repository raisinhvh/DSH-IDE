import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { describePackTools, loadToolpackTool, packCommands, packLine } from '../dist/toolpacks/access.mjs';

test('/pack commands are found anywhere in a message, only for known packs', () => {
  const ids = ['roblox', 'blender', 'my_pack'];
  assert.deepEqual(packCommands('/roblox fix the spawn', ids), ['roblox']);
  assert.deepEqual(packCommands('use /blender and /roblox, then /Blender again', ids), ['blender', 'roblox']);
  assert.deepEqual(packCommands('try /my_pack.', ids), ['my_pack']);
  assert.deepEqual(packCommands('see src/roblox or a/blender path, /job x, /figma', ids), []);
});

test('packs are listed one short line each', () => {
  assert.equal(packLine('Interact with Blender. Also does many other things.'), 'Interact with Blender.');
  assert.equal(packLine('No period here'), 'No period here');
  assert.equal(packLine('x'.repeat(200)).length, 120);
  const tool = loadToolpackTool([{ id: 'blender', description: 'Interact with Blender. Long details.' }]);
  assert.match(tool.description, /\nblender: Interact with Blender\.$/);
  assert.doesNotMatch(tool.description, /Long details/);
});

test('loaded pack tools are described with their arguments', () => {
  const text = describePackTools([{ name: 'blender_tree', description: 'Scene tree.', inputSchema: { type: 'object', properties: {} } }]);
  assert.equal(text, 'blender_tree: Scene tree.\nArguments: {"type":"object","properties":{}}');
});
