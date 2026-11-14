export interface AgentModel { value: string; name: string }

/** pi-ai's openai-codex catalog: the models a ChatGPT (Codex) subscription can run through DSH. */
export const CODEX_MODELS = ['gpt-5.5', 'gpt-5.3-codex-spark', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol'];
export const DEFAULT_CODEX_MODEL = 'gpt-6-sol';

/** Maps a ChatGPT (Codex) model backend to a catalog id. Legacy CLI values ('default', empty, unknown ids) become gpt-6-sol. */
export function codexBackend(backend: string | undefined): string {
  const value = backend?.trim() || '';
  return CODEX_MODELS.includes(value) ? value : DEFAULT_CODEX_MODEL;
}

export function hasNativeSpeed(provider: string): boolean {
  return provider === 'claude-cli';
}

/** Claude Code speed is a CLI setting; other providers may expose separate model routes. */
export function speedBackend(model: { provider: string; backend: string; speedOptions?: { label: string; backend: string }[] }, speed?: string): string {
  if (hasNativeSpeed(model.provider)) return model.backend;
  const backend = model.speedOptions?.find(option => option.label === speed)?.backend || model.backend;
  const tier = speedTier(speed);
  if (['openai', 'anthropic', 'openrouter', 'opencode-go', 'mistral', 'codex-cli'].includes(model.provider) && tier && tier !== 'default' &&
      (backend === model.backend || backend === `${model.backend}-${tier}`)) {
    throw new Error(`${model.provider} ${speed} is a request setting, not a model ID. The bundled DSH API adapter does not expose speed tiers. Choose None or configure a route to a separate available model.`);
  }
  return backend;
}

export function claudeSpeedSettings(speed?: string): string[] {
  const tier = speedTier(speed);
  if (tier === 'ultrafast') throw new Error('Claude Code does not offer an Ultrafast speed setting. Choose Fast or None.');
  return tier ? ['--settings', JSON.stringify({ fastMode: tier === 'fast' })] : [];
}

export function speedTier(speed?: string): string | undefined {
  const tier = speed?.toLowerCase().replace(/\s+/g, '');
  if (tier === 'fast' || tier === 'ultrafast') return tier;
  if (tier === 'none' || tier === 'standard') return 'default';
  return undefined;
}

/** Extract model choices from current ACP config options or the older models field. */
export function agentModels(value: Record<string, unknown>): AgentModel[] {
  const configs = Array.isArray(value.configOptions) ? value.configOptions as Record<string, unknown>[] : [];
  const model = configs.find(option => option.id === 'model' || option.category === 'model');
  if (model && Array.isArray(model.options)) {
    const options = (model.options as Record<string, unknown>[])
      .flatMap(option => Array.isArray(option.options) ? option.options as Record<string, unknown>[] : [option]);
    return options.filter(option => typeof option.value === 'string' && typeof option.name === 'string')
      .map(option => ({ value: option.value as string, name: option.name as string }));
  }
  const legacy = value.models as Record<string, unknown> | undefined;
  const available = legacy && Array.isArray(legacy.availableModels) ? legacy.availableModels as Record<string, unknown>[] : [];
  return available.filter(option => typeof option.modelId === 'string' && typeof option.name === 'string')
    .map(option => ({ value: option.modelId as string, name: option.name as string }));
}
