import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { PI_AI_BASE_URLS, isPiAiProvider, piAiCatalog, piAiPatch } from '../dist/runtime/piAi.mjs';

const catalogPath = ['@earendil-works', 'pi-ai', 'dist', 'providers', 'data', 'openrouter.json'];

test('only OpenRouter and OpenCode Go get an llm-pi-ai entry', () => {
  assert.equal(piAiPatch('deepseek-official', 'DEEPSEEK_API_KEY', 'deepseek-v4-flash', undefined), '');
  assert.equal(isPiAiProvider('constructor'), false);
  assert.ok(isPiAiProvider('openrouter') && isPiAiProvider('opencode-go'));
});

test('a catalog model gets the provider entry alone', () => {
  assert.equal(piAiPatch('openrouter', 'OPENROUTER_API_KEY', 'anthropic/claude-sonnet-4.5', new Set(['anthropic/claude-sonnet-4.5']), ['high']),
    '- id: llm-pi-ai\n  config:\n    providers:\n      openrouter:\n        apiKeyEnv: "OPENROUTER_API_KEY"\n');
  assert.equal(piAiPatch('opencode-go', 'OPENCODE_API_KEY', 'glm-5.3', new Set(['glm-5.3']), ['high']),
    '- id: llm-pi-ai\n  config:\n    providers:\n      opencode-go:\n        apiKeyEnv: "OPENCODE_API_KEY"\n');
});

test('a model outside the catalog is declared on the OpenAI-compatible endpoint with its pi-ai effort levels', () => {
  const text = piAiPatch('openrouter', 'OPENROUTER_API_KEY', 'someorg/new-model', new Set(['anthropic/claude-sonnet-4.5']), ['off', 'high', 'turbo']);
  assert.equal(text, '- id: llm-pi-ai\n  config:\n    providers:\n      openrouter:\n        apiKeyEnv: "OPENROUTER_API_KEY"\n'
    + `        api: "openai-completions"\n        baseURL: "${PI_AI_BASE_URLS.openrouter}"\n        models:\n          - id: "someorg/new-model"\n`
    + '            reasoningEfforts:\n              off: null\n              high: "high"\n');
  assert.doesNotMatch(piAiPatch('openrouter', 'OPENROUTER_API_KEY', 'someorg/new-model', undefined), /reasoningEfforts/);
  assert.match(piAiPatch('openrouter', 'OPENROUTER_API_KEY', 'any/model', undefined), /api: "openai-completions"/);
  assert.match(piAiPatch('opencode-go', 'OPENCODE_API_KEY', 'new-model', undefined), new RegExp(`baseURL: "${PI_AI_BASE_URLS['opencode-go']}"`));
});

test('the catalog is read from the pi-ai copy DSH resolves, preferring the one nested under dsh-llm-pi-ai', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pi-ai-'));
  try {
    const bin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    assert.equal(await piAiCatalog('openrouter', bin), undefined);
    const hoisted = join(root, 'node_modules', ...catalogPath);
    await mkdir(join(hoisted, '..'), { recursive: true });
    await writeFile(hoisted, JSON.stringify({ 'openai-completions': { 'a/one': {} }, 'anthropic-messages': { 'b/two': {} } }));
    assert.deepEqual([...await piAiCatalog('openrouter', bin)].sort(), ['a/one', 'b/two']);
    assert.equal(await piAiCatalog('opencode-go', bin), undefined);
    const nested = join(root, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'node_modules', ...catalogPath);
    await mkdir(join(nested, '..'), { recursive: true });
    await writeFile(nested, JSON.stringify({ 'openai-completions': { 'c/three': {} } }));
    assert.deepEqual([...await piAiCatalog('openrouter', bin)], ['c/three']);
    await writeFile(nested, 'not json');
    assert.equal(await piAiCatalog('openrouter', bin), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the bundled DSH ships OpenRouter and OpenCode Go catalogs the extension can read', async () => {
  const bin = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/lib/bin.js');
  for (const provider of ['openrouter', 'opencode-go']) {
    const catalog = await piAiCatalog(provider, bin);
    assert.ok(catalog && catalog.size > 0, provider);
  }
});
