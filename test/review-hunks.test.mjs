import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

// The extension build resolves this to the emitted JavaScript module.
const { computeHunks, applySelectedHunks } = await import("../dist/review/hunks.mjs");
const { assertApplyPrecondition, assertLocalFileScheme, contentEqualIgnoringLineEndings } = await import("../dist/review/guards.mjs");
const { pairExactRenames } = await import("../dist/review/renames.mjs");
const shadowBundle = await build({
  entryPoints: ["src/runtime/shadow.ts"], bundle: true, write: false, platform: "node", format: "esm",
  plugins: [{ name: "fake-vscode-shadow", setup(builder) {
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "fake" }));
    builder.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: "export const workspace = {};" }));
  } }],
});
const { mirrorPathExcluded } = await import(`data:text/javascript;base64,${Buffer.from(shadowBundle.outputFiles[0].text).toString("base64")}`);

test("computes separate replacement hunks with exact ranges", () => {
  const hunks = computeHunks("a\nb\nc\nd\n", "a\nB\nc\nD\n");
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks.map((h) => [h.baseStart, h.baseEnd, h.currentStart, h.currentEnd]), [
    [1, 2, 1, 2],
    [3, 4, 3, 4],
  ]);
});

test("applies only selected hunks and preserves unselected changes", () => {
  const base = "a\nb\nc\n";
  const current = "a\nB\nc\nC\n";
  const hunks = computeHunks(base, current);
  assert.equal(applySelectedHunks(base, current, [hunks[0].id]), "a\nB\nc\n");
  assert.equal(applySelectedHunks(base, current, [hunks[1].id]), "a\nb\nc\nC\n");
  assert.equal(applySelectedHunks(base, current, hunks.map((h) => h.id)), current);
});

test("supports insertions, deletions, and no-op input", () => {
  const base = "one\ntwo\nthree";
  const current = "one\nTHREE\n";
  const hunks = computeHunks(base, current);
  assert.equal(hunks.length, 1);
  assert.equal(applySelectedHunks(base, current, [hunks[0].id]), current);
  assert.equal(applySelectedHunks(base, current, []), base);
  assert.deepEqual(computeHunks(base, base), []);
});

test("bounds hunk calculation for large files", () => {
  const base = Array.from({ length: 1100 }, (_, i) => `line ${i}\n`).join("");
  const current = base.replace("line 1099", "changed");
  const hunks = computeHunks(base, current);
  assert.equal(hunks.length, 1);
  assert.equal(applySelectedHunks(base, current, [hunks[0].id]), current);
});

test("overwrites changed files while guarding deletions and rename sources", () => {
  assert.doesNotThrow(() => assertApplyPrecondition("a.ts", "base", "base", true, false));
  assert.doesNotThrow(() => assertApplyPrecondition("a.ts", "base", "changed", true, false));
  assert.throws(() => assertApplyPrecondition("a.ts", "base", "base", true, true), /dirty buffer/);
  assert.doesNotThrow(() => assertApplyPrecondition("new.ts", undefined, "occupied", false, false));
  assert.doesNotThrow(() => assertApplyPrecondition("missing.ts", "base", undefined, false, false));
  assert.doesNotThrow(() => assertApplyPrecondition("missing.ts", "base", undefined, true, true));
  assert.throws(() => assertApplyPrecondition("a.ts", "base", "changed", false, true), /Review conflict/);
});

test("allows deletion when only line endings differ", () => {
  assert.ok(contentEqualIgnoringLineEndings("alpha\r\n", "alpha\n"));
  assert.doesNotThrow(() => assertApplyPrecondition("a.ts", "alpha\n", "alpha\r\n", false, true));
  assert.throws(() => assertApplyPrecondition("a.ts", "alpha\n", "beta\n", false, true), /Review conflict/);
  assert.doesNotThrow(() => assertApplyPrecondition("a.ts", "alpha\n", "\uFEFFalpha\r\n", false, true));
  assert.throws(() => assertApplyPrecondition("a.ts", undefined, "existing content", false, true), /Review conflict/);
});

test("keeps untitled and remote documents out of the mirror", () => {
  assert.doesNotThrow(() => assertLocalFileScheme("file"));
  assert.throws(() => assertLocalFileScheme("untitled"), /untitled/);
  assert.throws(() => assertLocalFileScheme("vscode-remote"), /remote/);
});

test("pairs only unambiguous exact renames", () => {
  assert.deepEqual(pairExactRenames([
    { path: "old.ts", base: "code", proposed: undefined },
    { path: "new.ts", base: undefined, proposed: "code" },
  ]), [{ fromPath: "old.ts", path: "new.ts", text: "code" }]);
  assert.deepEqual(pairExactRenames([
    { path: "old.ts", base: "code", proposed: undefined },
    { path: "new-a.ts", base: undefined, proposed: "code" },
    { path: "new-b.ts", base: undefined, proposed: "code" },
  ]), []);
  assert.deepEqual(pairExactRenames([
    { path: "old-a.ts", base: "code", proposed: undefined },
    { path: "old-b.ts", base: "code", proposed: undefined },
    { path: "new.ts", base: undefined, proposed: "code" },
  ]), []);
});

test("includes .dsh/skills but excludes other .dsh paths in the mirror scope", () => {
  assert.equal(mirrorPathExcluded(".dsh/skills/foo/SKILL.md"), false);
  assert.equal(mirrorPathExcluded(".dsh/cache/session.json"), true);
  assert.equal(mirrorPathExcluded(".dsh/state.json"), true);
  assert.equal(mirrorPathExcluded("node_modules/pkg/index.js"), true);
});

test("excludes transient atomic-write temp files from the mirror scope", () => {
  assert.equal(mirrorPathExcluded("media/sidebar.js.tmp.20176.1d3b497de6e0"), true);
  assert.equal(mirrorPathExcluded("media/sidebar.js"), false);
});

test('small edits in large files stay small hunks', () => {
  const base = Array.from({ length: 2500 }, (_, i) => `line ${i}\n`);
  const current = [...base];
  current[3] = 'changed top\n';
  current.splice(1200, 0, 'inserted\n');
  current[2400] = 'changed bottom\n';
  const hunks = computeHunks(base.join(''), current.join(''));
  assert.equal(hunks.length, 3);
  assert.equal(hunks.reduce((sum, hunk) => sum + hunk.baseLines.length + hunk.currentLines.length, 0), 5);
  assert.equal(applySelectedHunks(base.join(''), current.join(''), hunks.map(hunk => hunk.id)), current.join(''));
  assert.equal(applySelectedHunks(base.join(''), current.join(''), []), base.join(''));
});

test('line-ending differences are not reported as changes', () => {
  const base = Array.from({ length: 1500 }, (_, i) => `line ${i}\r\n`);
  const current = Array.from({ length: 1500 }, (_, i) => (i === 700 ? 'edited\n' : `line ${i}\n`));
  const hunks = computeHunks(base.join(''), current.join(''));
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].baseLines, ['line 700\r\n']);
  assert.deepEqual(hunks[0].currentLines, ['edited\n']);
  assert.deepEqual(computeHunks('a\r\nb\r\n', 'a\nb\n'), []);
});

test('Myers diff agrees with a reference LCS on random edits', () => {
  let seed = 7;
  const random = max => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % max; };
  for (let round = 0; round < 200; round++) {
    const base = Array.from({ length: random(12) }, () => `${random(4)}\n`);
    const current = Array.from({ length: random(12) }, () => `${random(4)}\n`);
    const hunks = computeHunks(base.join(''), current.join(''));
    assert.equal(applySelectedHunks(base.join(''), current.join(''), hunks.map(hunk => hunk.id)), current.join(''));
    const table = Array.from({ length: base.length + 1 }, () => new Array(current.length + 1).fill(0));
    for (let i = base.length - 1; i >= 0; i--) for (let j = current.length - 1; j >= 0; j--) table[i][j] = base[i] === current[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    const changed = hunks.reduce((sum, hunk) => sum + hunk.baseLines.length + hunk.currentLines.length, 0);
    assert.equal(changed, base.length + current.length - 2 * table[0][0]);
  }
});
