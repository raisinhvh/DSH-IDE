import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(process.env.LOCALAPPDATA || '', 'cursor-agent', 'versions');
const version = existsSync(root) && readdirSync(root).sort().reverse().find(name =>
  existsSync(join(root, name, 'node.exe')) && existsSync(join(root, name, 'index.js')));
if (!version) throw new Error('Official Cursor Agent CLI is not installed.');

const child = spawn(join(root, version, 'node.exe'), [join(root, version, 'index.js'), 'acp'], {
  cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});
let buffer = '';
let stderr = '';
const timeout = setTimeout(() => { child.kill(); throw new Error(`Cursor ACP initialize timed out. ${stderr.slice(-2000)}`); }, 20000);
child.stderr.on('data', chunk => { stderr += String(chunk); });
child.stdout.on('data', chunk => {
  buffer += String(chunk);
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    const frame = JSON.parse(line);
    if (frame.id !== 1) continue;
    clearTimeout(timeout);
    if (frame.error) {
      console.error(frame.error);
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ protocolVersion: frame.result?.protocolVersion, authMethods: frame.result?.authMethods, agentInfo: frame.result?.agentInfo }));
    }
    child.stdin.end();
    child.kill();
  }
});
child.on('error', error => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'dsh-ide-smoke', version: '0.4.0' },
} }) + '\n');
