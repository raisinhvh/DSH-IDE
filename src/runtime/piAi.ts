import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** OpenRouter's OpenAI-compatible endpoint, which serves every model OpenRouter lists. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
/** Effort levels pi-ai accepts as `reasoningEfforts` keys. */
const PI_AI_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const CATALOG = ['@earendil-works', 'pi-ai', 'dist', 'providers', 'data', 'openrouter.json'];

/**
 * Model ids in the OpenRouter catalog of the pi-ai copy the DSH at `dshBin` loads, found the way Node resolves it
 * (dsh-llm-pi-ai's own node_modules first, then each ancestor's). Undefined when no catalog can be read.
 */
export async function openRouterCatalog(dshBin: string): Promise<Set<string> | undefined> {
  for (let dir = dirname(dshBin); ; dir = dirname(dir)) {
    for (const base of [join(dir, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'node_modules'), join(dir, 'node_modules')]) {
      let text: string;
      try { text = await readFile(join(base, ...CATALOG), 'utf8'); }
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
 * The llm-pi-ai entry for a DSH patch. dsh-base mounts llm-pi-ai with no routes, so OpenRouter has no adapter until
 * this declares one. A model missing from the installed catalog (or when the catalog cannot be read) is declared by
 * hand on the OpenAI-compatible endpoint, with the model's effort choices as its reasoning levels.
 */
export function piAiPatch(provider: string, envName: string, model: string, catalog: Set<string> | undefined, efforts: readonly string[] = []): string {
  if (provider !== 'openrouter') return '';
  const json = JSON.stringify;
  let text = `- id: llm-pi-ai\n  config:\n    providers:\n      openrouter:\n        apiKeyEnv: ${json(envName)}\n`;
  if (catalog?.has(model)) return text;
  text += `        api: "openai-completions"\n        baseURL: ${json(OPENROUTER_BASE_URL)}\n        models:\n          - id: ${json(model)}\n`;
  const levels = efforts.filter(effort => PI_AI_LEVELS.has(effort));
  if (levels.length) text += `            reasoningEfforts:\n${levels.map(level => `              ${level}: ${level === 'off' ? 'null' : json(level)}\n`).join('')}`;
  return text;
}
