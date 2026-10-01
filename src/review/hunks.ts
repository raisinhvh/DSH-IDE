/**
 * A contiguous group of changed lines between `base` and `current`.
 *
 * Line positions are zero based and the end positions are exclusive. An
 * insertion therefore has `baseStart === baseEnd`, while a deletion has
 * `currentStart === currentEnd`.
 */
export interface DiffHunk {
  /** Stable for a given diff ordering; suitable for UI selection state. */
  readonly id: string;
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly currentStart: number;
  readonly currentEnd: number;
  /** The exact line slices from the original and proposed texts. */
  readonly baseLines: readonly string[];
  readonly currentLines: readonly string[];
}

type Operation =
  | { readonly kind: "equal"; readonly base: number; readonly current: number }
  | { readonly kind: "delete"; readonly base: number; readonly current: number }
  | { readonly kind: "insert"; readonly base: number; readonly current: number };

/** Split without losing line endings, including a final unterminated line. */
function lines(text: string): string[] {
  if (text.length === 0) return [];
  const result: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code !== 10 && code !== 13) continue;
    if (code === 13 && text.charCodeAt(i + 1) === 10) {
      result.push(text.slice(start, i + 2));
      i += 1;
    } else {
      result.push(text.slice(start, i + 1));
    }
    start = i + 1;
  }
  if (start < text.length) result.push(text.slice(start));
  return result;
}

/** Lines compare equal when only their line ending differs, so LF/CRLF churn is not a change. */
const key = (line: string): string => line.replace(/\r\n$|[\r\n]$/, "");

const MAX_EDIT_DISTANCE = 3000;

/** Myers O(ND) diff over `a` and `b`; undefined when the edit distance exceeds the limit. */
function myers(a: string[], b: string[], offsetBase: number, offsetCurrent: number): Operation[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return undefined;

  const operations: Operation[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const snapshot = trace[d];
    const at = (k: number): number => snapshot[k + d + 1];
    const k = x - y;
    const insertion = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = insertion ? k + 1 : k - 1;
    const previousX = at(previousK);
    const editX = insertion ? previousX : previousX + 1;
    const editY = editX - k;
    while (x > editX && y > editY) {
      x -= 1; y -= 1;
      operations.push({ kind: "equal", base: x + offsetBase, current: y + offsetCurrent });
    }
    if (insertion) { y -= 1; operations.push({ kind: "insert", base: x + offsetBase, current: y + offsetCurrent }); }
    else { x -= 1; operations.push({ kind: "delete", base: x + offsetBase, current: y + offsetCurrent }); }
  }
  while (x > 0 && y > 0) {
    x -= 1; y -= 1;
    operations.push({ kind: "equal", base: x + offsetBase, current: y + offsetCurrent });
  }
  return operations.reverse();
}

/**
 * Compute line hunks from the original text (`base`) to a proposed text
 * (`current`). Unchanged lines are omitted. The implementation is deliberately
 * dependency free so it can also run in extension host tests.
 */
export function computeHunks(base: string, current: string): DiffHunk[] {
  if (base === current) return [];
  const oldLines = lines(base);
  const newLines = lines(current);
  const oldKeys = oldLines.map(key);
  const newKeys = newLines.map(key);
  const n = oldLines.length;
  const m = newLines.length;

  let prefix = 0;
  while (prefix < n && prefix < m && oldKeys[prefix] === newKeys[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && oldKeys[n - 1 - suffix] === newKeys[m - 1 - suffix]) suffix += 1;

  const middle = myers(oldKeys.slice(prefix, n - suffix), newKeys.slice(prefix, m - suffix), prefix, prefix);
  // A pathological rewrite is shown as one hunk over the changed region instead of the whole file.
  const operations: Operation[] = middle ?? [
    ...Array.from({ length: n - suffix - prefix }, (_, index): Operation => ({ kind: "delete", base: prefix + index, current: prefix })),
    ...Array.from({ length: m - suffix - prefix }, (_, index): Operation => ({ kind: "insert", base: n - suffix, current: prefix + index })),
  ];

  const hunks: DiffHunk[] = [];
  let operationIndex = 0;
  while (operationIndex < operations.length) {
    if (operations[operationIndex].kind === "equal") {
      operationIndex += 1;
      continue;
    }
    const first = operationIndex;
    while (
      operationIndex < operations.length &&
      operations[operationIndex].kind !== "equal"
    ) operationIndex += 1;
    const changed = operations.slice(first, operationIndex);
    const baseStart = changed[0].base;
    const currentStart = changed[0].current;
    const last = changed[changed.length - 1];
    const baseEnd = last.kind === "insert" ? last.base : last.base + 1;
    const currentEnd = last.kind === "delete" ? last.current : last.current + 1;
    hunks.push({
      id: `h${hunks.length}:${baseStart}-${baseEnd}:${currentStart}-${currentEnd}`,
      baseStart,
      baseEnd,
      currentStart,
      currentEnd,
      baseLines: oldLines.slice(baseStart, baseEnd),
      currentLines: newLines.slice(currentStart, currentEnd),
    });
  }
  return hunks;
}

/**
 * Apply only the selected hunks to `base`, leaving all other hunks untouched.
 * Unknown IDs are ignored. The returned text preserves the exact line slices
 * (and line endings) from each source text.
 */
export function applySelectedHunks(
  base: string,
  current: string,
  selectedIds: Iterable<string>,
): string {
  const oldLines = lines(base);
  const newLines = lines(current);
  const selected = new Set(selectedIds);
  const hunks = computeHunks(base, current);
  if (hunks.length === 0 || selected.size === 0) return base;

  const output: string[] = [];
  let baseCursor = 0;
  for (const hunk of hunks) {
    output.push(...oldLines.slice(baseCursor, hunk.baseStart));
    if (selected.has(hunk.id)) output.push(...newLines.slice(hunk.currentStart, hunk.currentEnd));
    else output.push(...oldLines.slice(hunk.baseStart, hunk.baseEnd));
    baseCursor = hunk.baseEnd;
  }
  output.push(...oldLines.slice(baseCursor));
  return output.join("");
}
