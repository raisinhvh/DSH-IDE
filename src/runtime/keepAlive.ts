export interface KeepAliveState {
  now: number;
  lastTurnAt?: number;
  contextTokens?: number;
  hint: number;
  pingsSent: number;
  max: number;
  shortCache?: boolean;
  running: boolean;
  visible: boolean;
}

/** Decide whether an idle, loaded chat should refresh its prompt cache. */
export function shouldKeepAlive(state: KeepAliveState): boolean {
  return state.visible && !state.running && !state.shortCache && state.max > 0 &&
    state.pingsSent < state.max && state.contextTokens !== undefined && state.contextTokens >= state.hint &&
    state.lastTurnAt !== undefined && state.now - state.lastTurnAt >= 50 * 60 * 1000;
}
