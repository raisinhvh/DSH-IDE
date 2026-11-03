import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { outline } from '../dist/summaries/store.mjs';

const cases = [
  ['a.ts', '/** Handles widgets. More detail. */\nexport function run(\n value: string\n): void {}\nclass Widget {\n  lookup(id: string): number { return 1; }\n}\n// function fake() {}', ['Purpose: Handles widgets.', 'export function run( value: string ): void', 'class Widget', '  lookup(id: string): number']],
  ['a.py', '"""Python module. More detail."""\nclass Widget:\n    def run(self, x: int) -> str:\n        return "x"\ndef work():\n    pass\n# def fake():', ['Purpose: Python module.', 'class Widget', '  def run(self, x: int) -> str', 'def work()']],
  ['a.go', '// Package widgets provides widgets.\npackage widgets\nfunc Run(x int) string { return "" }\ntype Widget struct {}\n// func Fake() {}', ['Purpose: Package widgets provides widgets.', 'func Run(x int) string', 'type Widget struct']],
  ['a.rs', '//! Rust module.\npub fn run(x: i32) -> i32 { x }\npub struct Widget {}\n// fn fake() {}', ['Purpose: Rust module.', 'pub fn run(x: i32) -> i32', 'pub struct Widget']],
  ['a.luau', '-- Lua module.\nlocal function run(x)\n  return x\nend\n-- function fake() end', ['Purpose: Lua module.', 'local function run(x)']],
];

for (const [path, source, expected] of cases) {
  test(`outlines ${path}`, () => {
    const result = outline(path, source);
    for (const item of expected) assert.ok(result?.includes(item), `${item} missing from ${result}`);
    assert.ok(!result.includes('fake'));
  });
}

test('constants holding functions keep their signature', () => {
  const result = outline('a.ts', 'export const hashText = (text: string): string => text.slice(0, 2);\nexport const run = async <T>(items: T[]): Promise<T[]> => {\n  return items;\n};\nconst LIMIT = 4;');
  assert.ok(result.includes('export const hashText = (text: string): string'), result);
  assert.ok(result.includes('export const run = async <T>(items: T[]): Promise<T[]>'), result);
  assert.ok(result.includes('const LIMIT'), result);
  assert.ok(!result.includes('slice'), result);
});

test('Luau outlines keep types and return types and skip service lookups', () => {
  const result = outline('a.luau', 'local Players = game:GetService("Players")\nlocal Net = require(script.Net)\nexport type Item = { id: string }\nlocal M = {}\nfunction M.get(id: string): Item?\n  local half = 4 // 2\n  return nil\nend\nreturn M');
  assert.ok(result.includes('export type Item'), result);
  assert.ok(result.includes('function M.get(id: string): Item?'), result);
  assert.ok(result.includes('local M'), result);
  assert.ok(!result.includes('Players') && !result.includes('Net'), result);
});

test('returns undefined when no outline can be extracted', () => {
  assert.equal(outline('a.txt', 'function run() {}'), undefined);
  assert.equal(outline('a.ts', '  '), undefined);
});
