import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const root = resolve(process.cwd());
const temporary = mkdtempSync(join(root, '.oauth-cli-smoke-'));
if (resolve(dirname(temporary)) !== root) throw new Error('Smoke directory escaped the workspace');
try {
  mkdirSync(join(temporary, 'codex'));
  mkdirSync(join(temporary, 'claude'));
  const codex = spawnSync('codex', ['login', 'status'], {
    env: { ...process.env, CODEX_HOME: join(temporary, 'codex'), OPENAI_API_KEY: '', CODEX_ACCESS_TOKEN: '', CODEX_API_KEY: '' },
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  if (codex.error) throw codex.error;
  if (!/not logged in/i.test(codex.stdout + codex.stderr)) throw new Error(`Codex did not isolate its login directory (${codex.status}): ${(codex.stdout + codex.stderr).slice(0, 500)}`);
  const installed = join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  const claude = spawnSync(existsSync(installed) ? installed : 'claude', ['auth', 'status', '--json'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(temporary, 'claude'), ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' },
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  if (claude.error) throw claude.error;
  const status = JSON.parse(claude.stdout);
  if (status.loggedIn !== false) throw new Error('Claude did not isolate its login directory');
  process.stdout.write('Codex and Claude CLIs honor isolated OAuth account directories.\n');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
