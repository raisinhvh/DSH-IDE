import assert from 'node:assert/strict';
import { commandProgram, displayTool, unwrapShell } from '../dist/runtime/toolDisplay.mjs';

// Claude Code: JSON input.
const bash = displayTool('Bash', JSON.stringify({ command: 'rg -n "foo" src', description: 'Search for foo' }));
assert.deepEqual(bash, { kind: 'shell', title: 'ripgrep', full: 'rg -n "foo" src' });
assert.equal(displayTool('Bash', JSON.stringify({ command: 'cd src && fd -e ts' })).title, 'fd');
assert.equal(displayTool('PowerShell', JSON.stringify({ command: 'git status --short' })).title, 'git status');
const read = displayTool('Read', JSON.stringify({ file_path: 'C:\\Users\\me\\Projects\\dsh\\src\\extension.ts' }));
assert.equal(read.title, 'Read');
assert.equal(read.kind, 'read');
assert.equal(read.detail, '…/dsh/src/extension.ts');
assert.equal(displayTool('Grep', JSON.stringify({ pattern: 'toolLabel', path: 'media' })).detail, 'media');
assert.equal(displayTool('mcp__dsh-delegate__read_file_summaries', JSON.stringify({ paths: ['a'] })).title, 'Summaries');
assert.equal(displayTool('mcp__claude_ai_Claude_Docs__guide').title, 'Guide');

// Codex: wrapped shell lines.
assert.equal(unwrapShell('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command \'sd foo bar a.ts\''), 'sd foo bar a.ts');
assert.equal(unwrapShell('bash -lc "rg x"'), 'rg x');
assert.equal(displayTool('Command', '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command \'rg -n x\'').title, 'ripgrep');
assert.equal(displayTool('File edit', 'src/a.ts').title, 'Edit');
assert.equal(displayTool('Web search', 'rust fd').kind, 'search');

// DSH batch calls and Cursor titles.
assert.equal(displayTool('read_file', 'package.json').title, 'Read');
assert.equal(displayTool('list_dir', 'src').title, 'List');
assert.equal(displayTool('`rg -n foo`').title, 'ripgrep');
assert.deepEqual(displayTool('Read src/a.ts'), { kind: 'read', title: 'Read', detail: 'src/a.ts', full: 'Read src/a.ts' });

assert.equal(commandProgram('FOO=1 npm test'), 'npm test');
assert.equal(commandProgram('Set-Location src; Get-ChildItem'), 'Get-ChildItem');

console.log('tool display tests passed');
