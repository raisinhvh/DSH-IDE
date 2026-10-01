export interface TextChange { path: string; base?: string; proposed?: string }
export interface ExactRename { fromPath: string; path: string; text: string }

/** Infer only unambiguous, content-preserving renames from a mirror scan. */
export function pairExactRenames(changes: readonly TextChange[]): ExactRename[] {
  const deletions = changes.filter(change => change.base !== undefined && change.proposed === undefined);
  const additions = changes.filter(change => change.base === undefined && change.proposed !== undefined);
  const used = new Set<string>();
  const pairs: ExactRename[] = [];
  for (const deletion of deletions) {
    if (deletions.filter(other => other.base === deletion.base).length !== 1) continue;
    const candidates = additions.filter(addition => !used.has(addition.path) && addition.proposed === deletion.base);
    if (candidates.length !== 1) continue;
    const addition = candidates[0];
    used.add(addition.path);
    pairs.push({ fromPath: deletion.path, path: addition.path, text: deletion.base! });
  }
  return pairs;
}
