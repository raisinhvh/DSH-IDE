import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { activateRustTools, pickRustToolAsset, rustToolsBin, withRustTools } from '../dist/runtime/rustTools.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const asset = (arch, overrides = {}) => ({ name: `fd-v10.2.0-${arch}-pc-windows-msvc.zip`, browser_download_url: `https://github.com/sharkdp/fd/releases/download/v10/archive.zip`, digest, ...overrides });
const x64 = asset('x86_64');
const arm = asset('aarch64');
assert.equal(pickRustToolAsset('fd', [x64, arm], 'x64').name, x64.name);
assert.equal(pickRustToolAsset('fd', [x64, arm], 'arm64').name, arm.name);
assert.equal(pickRustToolAsset('fd', [x64], 'arm64').name, x64.name);
assert.throws(() => pickRustToolAsset('fd', [asset('x86_64', { digest: undefined })]));
assert.throws(() => pickRustToolAsset('fd', [asset('x86_64', { browser_download_url: 'https://example.com/file.zip' })]));
const storage = mkdtempSync(join(tmpdir(), 'dsh-rust-test-'));
try {
  const bin = rustToolsBin(storage);
  activateRustTools(bin);
  const env = withRustTools({ Path: 'existing', BASH_ENV: 'user-env' });
  assert.equal(env.Path, `${bin}${delimiter}existing`);
  assert.equal(env.DSH_USER_BASH_ENV, 'user-env');
  assert.equal(env.BASH_ENV, join(storage, 'dependencies', 'rust-tools', 'bash-env.sh'));
  assert.match(readFileSync(env.BASH_ENV, 'utf8'), /case \$- in/);
} finally {
  rmSync(storage, { recursive: true, force: true });
}
