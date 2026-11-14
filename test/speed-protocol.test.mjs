import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speedBackend, codexBackend, CODEX_MODELS } from '../dist/runtime/models.mjs';

// Native ChatGPT (Codex) has no request speed tier: a speed choice only routes to another catalog model.
test('ChatGPT (Codex) speed routes run their own catalog model', () => {
  const model = { provider: 'codex-cli', backend: 'gpt-5.5', speedOptions: [
    { label: 'None', backend: 'gpt-5.5' },
    { label: 'Fast', backend: 'gpt-5.3-codex-spark' },
  ] };
  for (const [speed, backend] of [['Fast', 'gpt-5.3-codex-spark'], ['None', 'gpt-5.5'], [undefined, 'gpt-5.5']]) {
    const routed = speedBackend(model, speed);
    assert.equal(routed, backend);
    assert.equal(codexBackend(routed), backend);
  }
});

test('ChatGPT (Codex) refuses a tier that would only rename the base model', () => {
  for (const backend of ['gpt-5.5', 'gpt-5.5-fast', 'gpt-5.5-ultrafast']) {
    const model = { provider: 'codex-cli', backend: 'gpt-5.5', speedOptions: [{ label: 'Fast', backend }, { label: 'Ultrafast', backend }] };
    assert.throws(() => speedBackend(model, backend.endsWith('ultrafast') ? 'Ultrafast' : 'Fast'), /does not expose speed tiers/);
  }
});

test('every ChatGPT (Codex) catalog model maps to itself', () => {
  assert.ok(CODEX_MODELS.includes('gpt-5.5'));
  for (const model of CODEX_MODELS) assert.equal(codexBackend(model), model);
});
