export interface AgentModel { value: string; name: string }

export function hasNativeSpeed(provider: string): boolean {
  return provider === 'codex-cli' || provider === 'claude-cli';
}

/** Codex speed is a service tier; other providers may expose separate model routes. */
export function speedBackend(model: { provider: string; backend: string; speedOptions?: { label: string; backend: string }[] }, speed?: string): string {
  if (hasNativeSpeed(model.provider)) return model.backend;
  const backend = model.speedOptions?.find(option => option.label === speed)?.backend || model.backend;
  const tier = codexServiceTier(speed);
  if (['openai', 'anthropic', 'openrouter'].includes(model.provider) && tier && tier !== 'default' &&
      (backend === model.backend || backend === `${model.backend}-${tier}`)) {
    throw new Error(`${model.provider} ${speed} is a request setting, not a model ID. The bundled DSH API adapter does not expose speed tiers. Choose None or configure a route to a separate available model.`);
  }
  return backend;
}

export function claudeSpeedSettings(speed?: string): string[] {
  const tier = codexServiceTier(speed);
  if (tier === 'ultrafast') throw new Error('Claude Code does not offer an Ultrafast speed setting. Choose Fast or None.');
  return tier ? ['--settings', JSON.stringify({ fastMode: tier === 'fast' })] : [];
}

export function codexServiceTier(speed?: string): string | undefined {
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
