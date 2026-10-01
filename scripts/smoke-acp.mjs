import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const home = resolve('.smoke-home');
const patch = join(home, 'route.patch.yml');
await mkdir(home, { recursive: true });
await mkdir(join(home, 'workspace'), { recursive: true });
await writeFile(patch, '- id: acp\n  config:\n    provider: "deepseek-official"\n    model: "deepseek-v4-flash"\n');

const child = spawn('node', [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'acp', '--patch', patch], {
  env: { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: 'keyless-smoke-test' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});
let buffer = '';
let stderr = '';
const timeout = setTimeout(() => { child.kill(); process.exitCode = 1; }, 60000);
child.stderr.setEncoding('utf8');
child.stdout.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr += chunk; });
child.stdout.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (frame.id === 1) {
      if (frame.error) { console.error(frame.error); process.exitCode = 1; child.stdin.end(); }
      else {
        console.log(`ACP ready: ${frame.result?.agentInfo?.name || 'unknown agent'}`);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: join(home, 'workspace'), mcpServers: [] } }) + '\n');
      }
    } else if (frame.id === 2) {
      if (frame.error) { console.error(frame.error); process.exitCode = 1; child.stdin.end(); }
      else {
        console.log(`Session ready: ${frame.result?.sessionId || 'missing ID'}`);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/close', params: { sessionId: frame.result.sessionId } }) + '\n');
      }
    } else if (frame.id === 3) {
      if (frame.error) { console.error(frame.error); process.exitCode = 1; }
      child.stdin.end();
    }
  }
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => {
  clearTimeout(timeout);
  if (code !== 0) { console.error(stderr.slice(-3000)); process.exitCode = 1; }
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'dsh-ide-smoke', version: '0.1.0' },
} }) + '\n');
