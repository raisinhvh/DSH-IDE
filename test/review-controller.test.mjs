import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';

const documents = [];
const uri = path => ({ fsPath: path, toString: () => path });
class WorkspaceEdit {
  operations = [];
  createFile(target) { this.operations.push(['create', target.fsPath]); }
  deleteFile(target) { this.operations.push(['delete', target.fsPath]); }
  renameFile(source, target) { this.operations.push(['rename', source.fsPath, target.fsPath]); }
  insert(target, position, text) { this.operations.push(['write', target.fsPath, text]); }
  replace(target, range, text) { this.operations.push(['write', target.fsPath, text]); }
}
globalThis.__dshReviewTestVscode = {
  Uri: { file: uri, parse: uri }, WorkspaceEdit,
  Position: class {}, Range: class {},
  commands: { async executeCommand() {} },
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  window: { showWarningMessage() {} },
  workspace: {
    isTrusted: true, textDocuments: documents,
    registerTextDocumentContentProvider() { return { dispose() {} }; },
    fs: { createDirectory: target => fs.mkdir(target.fsPath, { recursive: true }) },
    async openTextDocument(target) {
      const existing = documents.find(doc => doc.uri.fsPath === target.fsPath);
      if (existing) return existing;
      const doc = { uri: target, text: await fs.readFile(target.fsPath, 'utf8'), getText() { return this.text; }, positionAt: offset => offset, isDirty: false };
      documents.push(doc);
      return doc;
    },
    async applyEdit(edit) {
      for (const op of edit.operations) {
        const [kind, ...args] = op;
        if (kind === 'create') await fs.writeFile(args[0], '');
        else if (kind === 'delete') await fs.rm(args[0], { force: true });
        else if (kind === 'rename') await fs.rename(args[0], args[1]);
        else if (kind === 'write') await fs.writeFile(args[0], args[1]);
        const doc = documents.find(doc => doc.uri.fsPath === (kind === 'rename' ? args[1] : args[0]));
        if (doc && kind === 'write') { doc.text = args[1]; doc.isDirty = false; }
        if (doc && kind === 'delete') documents.splice(documents.indexOf(doc), 1);
      }
      return true;
    },
  },
};
const bundle = await build({
  entryPoints: ['src/review/controller.ts'], bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'fake-vscode', setup(builder) {
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fake' }));
    builder.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: 'const api = globalThis.__dshReviewTestVscode; export const { Uri, WorkspaceEdit, Position, Range, EventEmitter, workspace, window, commands } = api;' }));
  } }],
});
const { ReviewController } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function makeController(root, onAcknowledge, onRestore) {
  const acks = [];
  const restores = [];
  const controller = new ReviewController(uri(root), async (path, text) => {
    acks.push(['ack', path, text]);
    await onAcknowledge?.(path, text, controller);
  }, 'dsh-review', async (path, text) => {
    restores.push(['restore', path, text]);
    await onRestore?.(path, text, controller);
  });
  controller._acks = acks;
  controller._restores = restores;
  return controller;
}

test('review overwrites manual edits and keeps all applied files visible after acknowledgement', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-review-test-'));
  let controller;
  try {
    await fs.writeFile(join(root, 'existing.txt'), 'manual edit');
    await fs.writeFile(join(root, 'new.txt'), 'manually created');
    controller = makeController(root, (path, text, ctrl) => {
      ctrl.update([{ path, base: text, proposed: text }]);
    });
    controller.update([
      { path: 'existing.txt', base: 'original', proposed: 'agent edit' },
      { path: 'new.txt', base: undefined, proposed: 'agent created' },
      { path: 'missing.txt', base: 'manually deleted', proposed: 'agent restored' },
    ]);
    await controller.queue;
    assert.equal(await fs.readFile(join(root, 'existing.txt'), 'utf8'), 'agent edit');
    assert.equal(await fs.readFile(join(root, 'new.txt'), 'utf8'), 'agent created');
    assert.equal(await fs.readFile(join(root, 'missing.txt'), 'utf8'), 'agent restored');
    assert.equal(controller.list().length, 3);
    assert.ok(controller.list().every(proposal => proposal.state === 'applied'));
    await controller.applyAll();
    assert.equal(controller.list().length, 0);
  } finally {
    controller?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejectAll clears applied proposals and restores baseline acknowledgements', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-review-test-'));
  let controller;
  try {
    await fs.writeFile(join(root, 'keep.txt'), 'original');
    controller = makeController(root);
    controller.update([{ path: 'keep.txt', base: 'original', proposed: 'agent edit' }]);
    await controller.queue;
    assert.equal(await fs.readFile(join(root, 'keep.txt'), 'utf8'), 'agent edit');
    await controller.rejectAll();
    assert.equal(controller.list().length, 0);
    assert.equal(await fs.readFile(join(root, 'keep.txt'), 'utf8'), 'original');
    assert.deepEqual(controller._restores.at(-1), ['restore', 'keep.txt', 'original']);
    controller.update([{ path: 'keep.txt', base: 'original', proposed: 'agent edit' }]);
    await controller.queue;
    assert.equal(controller.list().length, 0, 'settled rejection prevents proposal from reappearing');
  } finally {
    controller?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejectAll clears failed pending proposals and restores baseline', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-review-test-'));
  let controller;
  try {
    await fs.writeFile(join(root, 'blocked.txt'), 'user changed');
    controller = makeController(root);
    controller.update([{ path: 'blocked.txt', base: 'original', proposed: undefined }]);
    await controller.queue;
    assert.equal(controller.list().length, 1);
    assert.equal(controller.list()[0].state, 'pending');
    await controller.rejectAll();
    assert.equal(controller.list().length, 0);
    assert.equal(await fs.readFile(join(root, 'blocked.txt'), 'utf8'), 'user changed');
    assert.deepEqual(controller._restores, [['restore', 'blocked.txt', 'original']]);
  } finally {
    controller?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('deletion apply succeeds when the workspace file is already gone', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-review-test-'));
  let controller;
  try {
    controller = makeController(root);
    controller.update([{ path: 'gone.txt', base: 'content', proposed: undefined }]);
    await controller.queue;
    assert.equal(controller.list().length, 1);
    assert.equal(controller.list()[0].state, 'applied');
    await controller.applyAll();
    assert.equal(controller.list().length, 0);
  } finally {
    controller?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reject uses restore callback to rewind mirror bytes', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-review-test-'));
  const mirror = new Map();
  let controller;
  try {
    await fs.writeFile(join(root, 'keep.txt'), 'original');
    mirror.set('keep.txt', 'original');
    controller = makeController(root, (path, text) => {
      if (text === undefined) mirror.delete(path);
      else mirror.set(path, text);
    }, (path, text) => {
      if (text === undefined) mirror.delete(path);
      else mirror.set(path, text);
    });
    controller.update([{ path: 'keep.txt', base: 'original', proposed: 'agent edit' }]);
    await controller.queue;
    assert.equal(mirror.get('keep.txt'), 'agent edit');
    await controller.rejectAll();
    assert.equal(mirror.get('keep.txt'), 'original');
    assert.deepEqual(controller._restores.at(-1), ['restore', 'keep.txt', 'original']);
  } finally {
    controller?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('stale deletion rebases against an applied edit before auto-apply', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-review-test-'));
  let controller;
  try {
    await fs.writeFile(join(root, 'race.txt'), 'original');
    controller = makeController(root);
    controller.update([{ path: 'race.txt', base: 'original', proposed: 'edited' }]);
    await controller.queue;
    assert.equal(await fs.readFile(join(root, 'race.txt'), 'utf8'), 'edited');
    assert.equal(controller.list()[0].state, 'applied');
    controller.update([{ path: 'race.txt', base: 'original', proposed: undefined }]);
    await controller.queue;
    assert.equal(controller.list().length, 1);
    assert.equal(controller.list()[0].state, 'applied');
    await fs.access(join(root, 'race.txt')).then(() => assert.fail('file should be deleted')).catch(error => assert.equal(error.code, 'ENOENT'));
  } finally {
    controller?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rename with both paths missing stays a conflict', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-review-test-'));
  let controller;
  try {
    controller = makeController(root);
    controller.update([
      { path: 'old.ts', base: 'shared', proposed: undefined },
      { path: 'new.ts', base: undefined, proposed: 'shared' },
    ]);
    await controller.queue;
    assert.equal(controller.list().length, 1);
    assert.equal(controller.list()[0].state, 'pending');
    await assert.rejects(() => controller.applyAll(), /both missing/);
  } finally {
    controller?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rename removes the source when the target already exists', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-review-test-'));
  let controller;
  try {
    await fs.writeFile(join(root, 'old.ts'), 'shared');
    await fs.writeFile(join(root, 'new.ts'), 'shared');
    controller = makeController(root);
    controller.update([
      { path: 'old.ts', base: 'shared', proposed: undefined },
      { path: 'new.ts', base: undefined, proposed: 'shared' },
    ]);
    await controller.queue;
    assert.equal(controller.list()[0].state, 'applied');
    await fs.access(join(root, 'old.ts')).then(() => assert.fail('old path should be removed')).catch(error => assert.equal(error.code, 'ENOENT'));
    assert.equal(await fs.readFile(join(root, 'new.ts'), 'utf8'), 'shared');
  } finally {
    controller?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('deletion apply succeeds with CRLF workspace content against LF baseline', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-review-test-'));
  let controller;
  try {
    await fs.writeFile(join(root, 'crlf.txt'), 'content\r\n');
    controller = makeController(root);
    controller.update([{ path: 'crlf.txt', base: 'content\n', proposed: undefined }]);
    await controller.queue;
    assert.equal(controller.list()[0].state, 'applied');
    await fs.access(join(root, 'crlf.txt')).then(() => assert.fail('file should be deleted')).catch(error => assert.equal(error.code, 'ENOENT'));
  } finally {
    controller?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rename apply succeeds when the workspace already reflects the rename', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-review-test-'));
  let controller;
  try {
    await fs.writeFile(join(root, 'new.ts'), 'shared');
    controller = makeController(root);
    controller.update([
      { path: 'old.ts', base: 'shared', proposed: undefined },
      { path: 'new.ts', base: undefined, proposed: 'shared' },
    ]);
    await controller.queue;
    assert.equal(controller.list().length, 1);
    assert.equal(controller.list()[0].state, 'applied');
    assert.equal(await fs.readFile(join(root, 'new.ts'), 'utf8'), 'shared');
    await fs.access(join(root, 'old.ts')).then(() => assert.fail('old path should be gone')).catch(error => assert.equal(error.code, 'ENOENT'));
  } finally {
    controller?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
