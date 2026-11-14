import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { agentModels, speedBackend, speedTier, claudeSpeedSettings, codexBackend } from '../dist/runtime/models.mjs';

test('native Codex has no speed tiers and maps legacy CLI backends to a catalog model', () => {
  const model = { provider: 'codex-cli', backend: 'gpt-6-sol', speedOptions: [
    { label: 'None', backend: 'gpt-6-sol' },
    { label: 'Fast', backend: 'gpt-6-sol-fast' },
  ] };
  assert.equal(speedBackend(model, 'None'), 'gpt-6-sol');
  assert.throws(() => speedBackend(model, 'Fast'), /does not expose speed tiers/);
  assert.equal(speedBackend({ ...model, provider: 'cursor-acp' }, 'Fast'), 'gpt-6-sol-fast');
  assert.equal(codexBackend('gpt-6-sol'), 'gpt-6-sol');
  assert.equal(codexBackend('default'), 'gpt-6-sol');
  assert.equal(codexBackend(''), 'gpt-6-sol');
  assert.equal(codexBackend(undefined), 'gpt-6-sol');
  assert.equal(codexBackend('gpt-6.1-sol'), 'gpt-6-sol');
});

test('speed labels map to tiers', () => {
  assert.equal(speedTier('Fast'), 'fast');
  assert.equal(speedTier('Ultrafast'), 'ultrafast');
  assert.equal(speedTier('None'), 'default');
  assert.equal(speedTier('Standard'), 'default');
  assert.equal(speedTier(undefined), undefined);
});

test('Claude speed sets fastMode separately, including explicitly turning it off', () => {
  assert.equal(speedBackend({ provider: 'claude-cli', backend: 'opus', speedOptions: [{ label: 'Fast', backend: 'opus-fast' }] }, 'Fast'), 'opus');
  assert.deepEqual(claudeSpeedSettings('Fast'), ['--settings', '{"fastMode":true}']);
  assert.deepEqual(claudeSpeedSettings('None'), ['--settings', '{"fastMode":false}']);
  assert.deepEqual(claudeSpeedSettings('Standard'), ['--settings', '{"fastMode":false}']);
  assert.deepEqual(claudeSpeedSettings(undefined), []);
  assert.throws(() => claudeSpeedSettings('Ultrafast'), /does not offer/);
});

test('API routes refuse unsupported tier settings but preserve real alternate models', () => {
  for (const provider of ['openai', 'anthropic', 'openrouter', 'opencode-go']) {
    for (const backend of ['base', 'base-fast']) {
      assert.throws(() => speedBackend({ provider, backend: 'base', speedOptions: [{ label: 'Fast', backend }] }, 'Fast'), /does not expose speed tiers/);
    }
    assert.equal(speedBackend({ provider, backend: 'base', speedOptions: [{ label: 'Fast', backend: 'smaller-model' }] }, 'Fast'), 'smaller-model');
  }
  for (const provider of ['cursor-acp', 'deepseek-official']) {
    assert.equal(speedBackend({ provider, backend: 'base', speedOptions: [{ label: 'Fast', backend: 'base-fast' }] }, 'Fast'), 'base-fast');
  }
});

test('reads Cursor model choices from ACP session config options', () => {
  assert.deepEqual(agentModels({ configOptions: [
    { id: 'mode', options: [{ value: 'agent', name: 'Agent' }] },
    { id: 'model', category: 'model', options: [
      { value: 'auto', name: 'Auto' },
      { group: 'frontier', options: [{ value: 'gpt-5', name: 'GPT 5' }] },
    ] },
  ] }), [{ value: 'auto', name: 'Auto' }, { value: 'gpt-5', name: 'GPT 5' }]);
});

test('reads Cursor legacy ACP model choices', () => {
  assert.deepEqual(agentModels({ models: { currentModelId: 'auto', availableModels: [
    { modelId: 'auto', name: 'Auto' }, { modelId: 'sonnet', name: 'Sonnet' },
  ] } }), [{ value: 'auto', name: 'Auto' }, { value: 'sonnet', name: 'Sonnet' }]);
});
