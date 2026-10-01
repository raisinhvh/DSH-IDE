import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getSidebarHtml, initialSidebarState } from '../dist/sidebar/view.mjs';

const state = initialSidebarState();
const pickerPreview = process.argv[2] === 'picker';
const page = process.argv[2] === 'chat' || pickerPreview ? 'chat' : 'accounts';
state.page = page;
state.models = [
  { id: 'Codex Default', name: 'Codex Default', provider: 'codex-cli', backend: 'default', configured: true,
    speedOptions: [{ label: 'None', backend: 'default' }, { label: 'Fast', backend: 'gpt-fast' }, { label: 'Ultrafast', backend: 'gpt-ultrafast' }],
    effortOptions: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'Claude Default', name: 'Claude Default', provider: 'claude-cli', backend: 'default', configured: true },
  { id: 'Cursor Auto', name: 'Cursor Auto', provider: 'cursor-acp', backend: 'auto', configured: true },
  { id: 'DeepSeek V4 Flash', name: 'DeepSeek V4 Flash', provider: 'deepseek-official', backend: 'deepseek-v4-flash', configured: true },
];
state.selectedModelId = 'Codex Default';
state.selectedSpeed = 'None';
state.selectedEffort = 'medium';
state.accounts = [
  { id: '1', provider: 'codex-cli', label: 'XYZ', email: 'xyz@gmail.com', isDefault: true, authType: 'oauth' },
  { id: '2', provider: 'codex-cli', label: 'ABC', email: 'abc@gmail.com', isDefault: false, authType: 'oauth' },
  { id: '3', provider: 'claude-cli', label: 'Work', email: 'work@example.com', isDefault: true, authType: 'oauth' },
];
state.sessions = [
  { id: 'a', name: 'Fix sidebar', updatedAt: Date.now() },
  { id: 'b', name: 'Review OAuth', updatedAt: Date.now() - 1000 },
  { id: 'c', name: 'Refactor runtime', updatedAt: Date.now() - 2000 },
];
state.activeSessionId = 'a';
state.cursor = { connected: true, label: 'cursor@example.com' };
let html = getSidebarHtml({ cspSource: 'file:' }, state, {
  stylesheet: 'media/sidebar.css', script: 'media/sidebar.js', font: 'media/MaterialSymbolsRounded.woff2',
});
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/, '');
html = html.replace('</head>', `<style>:root{--vscode-foreground:#dddddd;--vscode-descriptionForeground:#999;--vscode-sideBar-background:#181818;--vscode-sideBarSectionHeader-background:#222;--vscode-editor-background:#1e1e1e;--vscode-icon-foreground:#ddd;--vscode-font-family:Arial,sans-serif;--vscode-button-background:#1766a6;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#333;--vscode-button-secondaryForeground:#eee;--vscode-panel-border:#444;--vscode-input-background:#242424;--vscode-textLink-foreground:#71b9ff;--vscode-badge-background:#444;--vscode-badge-foreground:#ddd;--vscode-testing-iconPassed:#60b579;--vscode-testing-iconFailed:#d57676;--vscode-dropdown-background:#222;--vscode-list-hoverBackground:#333;--vscode-editor-inactiveSelectionBackground:#303c48}body{width:360px}</style></head>`);
html = html.replace('<script nonce=', `<script>window.acquireVsCodeApi=()=>({postMessage:()=>{},getState:()=>({page:"${page}"}),setState:()=>{}})</script><script nonce=`);
if (pickerPreview) html = html.replace('</body>', '<script>setTimeout(()=>document.getElementById("model-picker").click(),100)</script></body>');
writeFileSync(resolve(`preview-${pickerPreview ? 'picker' : page}.html`), html);
