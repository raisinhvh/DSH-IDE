import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * The OpenAI-compatible endpoint of each provider DSH routes through llm-pi-ai. OpenRouter's serves every model it
 * lists; OpenCode Go's serves its Chat Completions models, which are most of the Go lineup.
 */
export const PI_AI_BASE_URLS: Readonly<Record<string, string>> = {
  openrouter: 'https://openrouter.ai/api/v1',
  'opencode-go': 'https://opencode.ai/zen/go/v1',
};
/** Effort levels pi-ai accepts as `reasoningEfforts` keys. */
const PI_AI_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const CATALOG_DIR = ['@earendil-works', 'pi-ai', 'dist', 'providers', 'data'];

export function isPiAiProvider(provider: string): boolean {
  return Object.hasOwn(PI_AI_BASE_URLS, provider);
}

/**
 * Model ids in `provider`'s catalog of the pi-ai copy the DSH at `dshBin` loads, found the way Node resolves it
 * (dsh-llm-pi-ai's own node_modules first, then each ancestor's). Undefined when no catalog can be read.
 */
export async function piAiCatalog(provider: string, dshBin: string): Promise<Set<string> | undefined> {
  if (!isPiAiProvider(provider)) return undefined;
  for (let dir = dirname(dshBin); ; dir = dirname(dir)) {
    for (const base of [join(dir, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'node_modules'), join(dir, 'node_modules')]) {
      let text: string;
      try { text = await readFile(join(base, ...CATALOG_DIR, `${provider}.json`), 'utf8'); }
      catch { continue; }
      try {
        const groups = JSON.parse(text) as Record<string, unknown>;
        return new Set(Object.values(groups).flatMap(group => group && typeof group === 'object' ? Object.keys(group) : []));
      } catch { return undefined; }
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * The llm-pi-ai entry for a DSH patch. dsh-base mounts llm-pi-ai with no routes, so OpenRouter and OpenCode Go have
 * no adapter until this declares one. A model missing from the installed catalog (or when the catalog cannot be read)
 * is declared by hand on the provider's OpenAI-compatible endpoint, with the model's effort choices as its reasoning
 * levels.
 */
export function piAiPatch(provider: string, envName: string, model: string, catalog: Set<string> | undefined, efforts: readonly string[] = []): string {
  if (!isPiAiProvider(provider)) return '';
  const json = JSON.stringify;
  let text = `- id: llm-pi-ai\n  config:\n    providers:\n      ${provider}:\n        apiKeyEnv: ${json(envName)}\n`;
  if (catalog?.has(model)) return text;
  text += `        api: "openai-completions"\n        baseURL: ${json(PI_AI_BASE_URLS[provider])}\n        models:\n          - id: ${json(model)}\n`;
  const levels = efforts.filter(effort => PI_AI_LEVELS.has(effort));
  if (levels.length) text += `            reasoningEfforts:\n${levels.map(level => `              ${level}: ${level === 'off' ? 'null' : json(level)}\n`).join('')}`;
  return text;
}
