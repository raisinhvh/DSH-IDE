/** Adds the built-in explorer without replacing a user profile of the same name. */
export function withExplorer<T extends { name: string }>(profiles: T[], choice: { model?: string; effort?: string; speed?: string }): (T | { name: string; description: string; model: string; effort?: string; speed?: string; mode: 'read-only' })[] {
  if (!choice.model || profiles.some(profile => profile.name === 'explorer')) return profiles;
  return [...profiles, { name: 'explorer', description: 'Searches and reads files and returns a concise answer.', model: choice.model, effort: choice.effort, speed: choice.speed, mode: 'read-only' }];
}
