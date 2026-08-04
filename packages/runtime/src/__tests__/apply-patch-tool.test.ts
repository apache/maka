import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBuiltinTools } from '../builtin-tools.js';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import { executeApplyPatchWithAdapter, type ApplyPatchFsAdapter } from '../apply-patch-engine.js';
import { projectEffectiveProductToolSurface } from '../tool-catalog-derive.js';
import { executeFilesystemWorkerRequest } from '../filesystem-worker/operations.js';
import {
  FILESYSTEM_WORKER_PROTOCOL_VERSION,
  type FilesystemWorkerOperation,
  type FilesystemWorkerRequest,
  type FilesystemWorkerTarget,
} from '../filesystem-worker/protocol.js';
import type { MakaToolContext } from '../tool-runtime.js';

function toolCtx(cwd: string): MakaToolContext {
  return {
    sessionId: 's',
    turnId: 't',
    cwd,
    toolCallId: 'c',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

function envelope(body: string): string {
  return `*** Begin Patch\n${body}*** End Patch\n`;
}

describe('editingProtocol projection', () => {
  test('edit_write is the default and omits ApplyPatch', () => {
    const surface = projectEffectiveProductToolSurface({
      host: 'cli',
      tools: buildBuiltinTools(),
      policy: { economy: false },
    });
    assert.ok(surface.toolNames.has('Write'));
    assert.ok(surface.toolNames.has('Edit'));
    assert.equal(surface.toolNames.has('ApplyPatch'), false);
  });

  test('apply_patch exposes ApplyPatch and omits Write/Edit', () => {
    const surface = projectEffectiveProductToolSurface({
      host: 'cli',
      tools: buildBuiltinTools(),
      policy: { economy: false, editingProtocol: 'apply_patch' },
    });
    assert.ok(surface.toolNames.has('ApplyPatch'));
    assert.equal(surface.toolNames.has('Write'), false);
    assert.equal(surface.toolNames.has('Edit'), false);
  });

  test('never advertises both editing protocols', () => {
    for (const protocol of ['edit_write', 'apply_patch'] as const) {
      const names = projectEffectiveProductToolSurface({
        host: 'cli',
        tools: buildBuiltinTools({ includeEdit: true }),
        policy: { economy: false, editingProtocol: protocol },
      }).toolNames;
      const hasClassic = names.has('Write') || names.has('Edit');
      const hasPatch = names.has('ApplyPatch');
      assert.equal(hasClassic && hasPatch, false);
      assert.ok(hasClassic || hasPatch);
    }
  });
});

describe('ApplyPatch tool integration', () => {
  test('rejects Add and Move when the destination already exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-apply-patch-exists-'));
    try {
      await writeFile(join(root, 'existing.txt'), 'keep\n', 'utf8');
      await writeFile(join(root, 'source.txt'), 'src\n', 'utf8');
      const tools = buildBuiltinTools();
      const apply = tools.find((tool) => tool.name === 'ApplyPatch');
      assert.ok(apply);

      await assert.rejects(async () => {
        await apply.impl(
          {
            patch: envelope(['*** Add File: existing.txt', '+nope', ''].join('\n')),
          },
          toolCtx(root),
        );
      }, /already exists/i);
      assert.equal(await readFile(join(root, 'existing.txt'), 'utf8'), 'keep\n');

      await assert.rejects(async () => {
        await apply.impl(
          {
            patch: envelope(
              [
                '*** Update File: source.txt',
                '*** Move to: existing.txt',
                '@@',
                '-src',
                '+moved',
                '',
              ].join('\n'),
            ),
          },
          toolCtx(root),
        );
      }, /already exists/i);
      assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'src\n');
      assert.equal(await readFile(join(root, 'existing.txt'), 'utf8'), 'keep\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('add, update, delete, multi-file, mismatch, and absolute path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-apply-patch-'));
    try {
      await writeFile(join(root, 'existing.txt'), 'hello world\n', 'utf8');
      await writeFile(join(root, 'to-delete.txt'), 'bye\n', 'utf8');
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src', 'a.ts'), 'const x = 1;\n', 'utf8');

      const tools = buildBuiltinTools();
      const apply = tools.find((tool) => tool.name === 'ApplyPatch');
      assert.ok(apply);

      const multi = await apply.impl(
        {
          patch: envelope(
            [
              '*** Add File: new.txt',
              '+created',
              '*** Update File: existing.txt',
              '@@',
              '-hello world',
              '+hello maka',
              '*** Delete File: to-delete.txt',
              '',
            ].join('\n'),
          ),
        },
        toolCtx(root),
      );
      assert.equal((multi as { ok: boolean }).ok, true);
      assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'created\n');
      assert.equal(await readFile(join(root, 'existing.txt'), 'utf8'), 'hello maka\n');
      await assert.rejects(() => readFile(join(root, 'to-delete.txt'), 'utf8'));

      const nested = await apply.impl(
        {
          patch: envelope(
            ['*** Add File: generated/deep/nested.txt', '+created with parents', ''].join('\n'),
          ),
        },
        toolCtx(root),
      );
      assert.equal((nested as { ok: boolean }).ok, true);
      assert.equal(
        await readFile(join(root, 'generated', 'deep', 'nested.txt'), 'utf8'),
        'created with parents\n',
      );

      const before = await readFile(join(root, 'src', 'a.ts'), 'utf8');
      await assert.rejects(async () => {
        await apply.impl(
          {
            patch: envelope(
              ['*** Update File: src/a.ts', '@@', '-const y = 2;', '+const y = 3;', ''].join('\n'),
            ),
          },
          toolCtx(root),
        );
      }, /hunk did not match|ApplyPatch/);
      assert.equal(await readFile(join(root, 'src', 'a.ts'), 'utf8'), before);

      await assert.rejects(async () => {
        await apply.impl(
          {
            patch: envelope(['*** Add File: /tmp/evil.txt', '+nope', ''].join('\n')),
          },
          toolCtx(root),
        );
      }, /absolute|relative/i);

      const moved = await apply.impl(
        {
          patch: envelope(
            [
              '*** Update File: src/a.ts',
              '*** Move to: src/b.ts',
              '@@',
              '-const x = 1;',
              '+const x = 2;',
              '',
            ].join('\n'),
          ),
        },
        toolCtx(root),
      );
      assert.equal((moved as { ok: boolean }).ok, true);
      assert.equal(await readFile(join(root, 'src', 'b.ts'), 'utf8'), 'const x = 2;\n');
      await assert.rejects(() => readFile(join(root, 'src', 'a.ts'), 'utf8'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('Delete unlinks a symlink while Update plus Move rejects one without side effects', async (t) => {
    if (process.platform === 'win32') {
      t.skip('file symlink creation is not reliably available on Windows CI');
      return;
    }
    const root = await mkdtemp(join(tmpdir(), 'maka-apply-patch-symlink-'));
    try {
      await writeFile(join(root, 'target.txt'), 'target\n', 'utf8');
      await symlink('target.txt', join(root, 'delete-link.txt'));
      await symlink('target.txt', join(root, 'move-link.txt'));
      const apply = buildBuiltinTools().find((tool) => tool.name === 'ApplyPatch');
      assert.ok(apply);

      await apply.impl(
        {
          patch: envelope(['*** Delete File: delete-link.txt', ''].join('\n')),
        },
        toolCtx(root),
      );
      await assert.rejects(() => lstat(join(root, 'delete-link.txt')));
      assert.equal(await readFile(join(root, 'target.txt'), 'utf8'), 'target\n');

      await assert.rejects(
        async () =>
          await apply.impl(
            {
              patch: envelope(
                [
                  '*** Update File: move-link.txt',
                  '*** Move to: moved.txt',
                  '@@',
                  '-target',
                  '+moved',
                  '',
                ].join('\n'),
              ),
            },
            toolCtx(root),
          ),
        /regular file/i,
      );
      assert.equal((await lstat(join(root, 'move-link.txt'))).isSymbolicLink(), true);
      assert.equal(await readFile(join(root, 'target.txt'), 'utf8'), 'target\n');
      await assert.rejects(() => lstat(join(root, 'moved.txt')));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('managed-worker Add and Move to missing destinations preflight cleanly', async (t) => {
    if (process.platform === 'win32') {
      // canWritePath matches workspace roots with POSIX separators; the
      // preflight path space on Windows is a pre-existing gap, not part of
      // the managed-worker behavior under test (CI runs POSIX).
      t.skip('managed permission matching requires POSIX host paths');
      return;
    }
    const root = await mkdtemp(join(tmpdir(), 'maka-apply-patch-managed-'));
    try {
      await writeFile(join(root, 'source.txt'), 'src\n', 'utf8');
      const worker = {
        async execute(input: {
          operation: FilesystemWorkerOperation;
          cwd: string;
        }): Promise<unknown> {
          const expectedTarget = await workerExpectedTarget(root, input.operation);
          // The real client sends the absolute display/enforcement path as the
          // operand; the worker revalidates it against expectedTarget.
          const operation: FilesystemWorkerOperation = {
            ...input.operation,
            cwd: input.cwd,
            path: expectedTarget.displayPath,
          };
          const request: FilesystemWorkerRequest = {
            version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
            requestId: 'request-1',
            operation,
            operationBoundary: {
              filesystem: {
                entries: [
                  {
                    path: expectedTarget.enforcementPath,
                    access: expectedTarget.access,
                    scope: expectedTarget.scope,
                  },
                ],
              },
            },
            expectedTarget,
          };
          const response = await executeFilesystemWorkerRequest(request);
          if (!response.ok) throw new Error(response.error.message);
          return response.result;
        },
      };
      const apply = buildBuiltinTools({
        filesystemWorker: worker as never,
        permissionProfile: createWorkspaceWritePermissionProfile(),
      }).find((tool) => tool.name === 'ApplyPatch');
      assert.ok(apply);

      // Add a brand-new file: the preflight lstat must classify the missing
      // destination as `missing`, not not_found.
      const added = await apply.impl(
        {
          patch: envelope(['*** Add File: generated/deep/new.txt', '+created', ''].join('\n')),
        },
        toolCtx(root),
      );
      assert.equal((added as { ok: boolean }).ok, true);
      assert.equal(await readFile(join(root, 'generated', 'deep', 'new.txt'), 'utf8'), 'created\n');

      // Move to a missing destination: the destination lstat is missing and
      // the source delete lands on the source entry.
      const moved = await apply.impl(
        {
          patch: envelope(
            [
              '*** Update File: source.txt',
              '*** Move to: moved-away.txt',
              '@@',
              '-src',
              '+moved',
              '',
            ].join('\n'),
          ),
        },
        toolCtx(root),
      );
      assert.equal((moved as { ok: boolean }).ok, true);
      assert.equal(await readFile(join(root, 'moved-away.txt'), 'utf8'), 'moved\n');
      await assert.rejects(() => readFile(join(root, 'source.txt'), 'utf8'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('product-tool surface editingProtocol', () => {
  test('projector selects exactly one editing protocol from bound tools', () => {
    const tools = buildBuiltinTools({ includeEdit: true });
    const editWrite = projectEffectiveProductToolSurface({
      host: 'cli',
      tools,
      policy: { economy: false, editingProtocol: 'edit_write' },
    });
    assert.ok(editWrite.toolNames.has('Write'));
    assert.ok(editWrite.toolNames.has('Edit'));
    assert.equal(editWrite.toolNames.has('ApplyPatch'), false);
    assert.equal(editWrite.identity.policy.editingProtocol, 'edit_write');

    const applyPatch = projectEffectiveProductToolSurface({
      host: 'cli',
      tools,
      policy: { economy: false, editingProtocol: 'apply_patch' },
    });
    assert.ok(applyPatch.toolNames.has('ApplyPatch'));
    assert.equal(applyPatch.toolNames.has('Write'), false);
    assert.equal(applyPatch.toolNames.has('Edit'), false);
    assert.equal(applyPatch.identity.policy.editingProtocol, 'apply_patch');
  });

  test('builder binds the union and the default projector selects edit_write once', () => {
    const tools = buildBuiltinTools({ includeEdit: true });
    const surface = projectEffectiveProductToolSurface({
      host: 'cli',
      tools,
      policy: { economy: false },
    });
    assert.equal(surface.toolNames.has('ApplyPatch'), false);
    assert.ok(surface.toolNames.has('Write'));
    assert.ok(surface.toolNames.has('Edit'));
    assert.equal(surface.identity.policy.editingProtocol, 'edit_write');
  });
});

describe('shared ApplyPatch engine partial move failure', () => {
  test('reports partial=true and completed destination when source delete fails', async () => {
    const files = new Map<string, string>([['src.txt', 'hello\n']]);
    const fs: ApplyPatchFsAdapter = {
      async lockKey(path) {
        return path;
      },
      async lstat(path) {
        return files.has(path) ? 'file' : 'missing';
      },
      async readText(path) {
        const content = files.get(path);
        if (content === undefined) throw new Error(`missing ${path}`);
        return content;
      },
      async writeText(path, content) {
        files.set(path, content);
        return { path, bytes: Buffer.byteLength(content, 'utf8') };
      },
      async deletePath(path) {
        if (path === 'src.txt') throw new Error('delete failed');
        files.delete(path);
        return { path };
      },
    };

    const result = await executeApplyPatchWithAdapter(
      envelope(
        ['*** Update File: src.txt', '*** Move to: dest.txt', '@@', '-hello', '+hello', ''].join(
          '\n',
        ),
      ),
      fs,
      async (_key, run) => run(),
    );

    assert.equal(result.ok, false);
    assert.equal(result.partial, true);
    assert.deepEqual(result.completed, ['dest.txt']);
    assert.deepEqual(result.uncompleted, ['src.txt']);
    assert.ok(files.has('dest.txt'));
    assert.ok(files.has('src.txt'));
  });

  test('preflightPermissions runs before mutation and rethrows structured boundary errors', async () => {
    const files = new Map<string, string>([
      ['a.txt', 'a\n'],
      ['b.txt', 'b\n'],
    ]);
    let writes = 0;
    let preflighted: string[] = [];
    const boundaryError = Object.assign(new Error('sandbox boundary required'), {
      domain: 'filesystem',
      reason: 'sandbox_boundary_required',
      requiredExpansion: {
        filesystem: {
          entries: [{ path: '/tmp/workspace/b.txt', access: 'write', scope: 'exact' }],
        },
      },
    });
    const fs: ApplyPatchFsAdapter = {
      async lockKey(path) {
        return path;
      },
      async lstat(path) {
        return files.has(path) ? 'file' : 'missing';
      },
      async readText(path) {
        const content = files.get(path);
        if (content === undefined) throw new Error(`missing ${path}`);
        return content;
      },
      async writeText(path, content) {
        writes += 1;
        files.set(path, content);
        return { path, bytes: Buffer.byteLength(content, 'utf8') };
      },
      async deletePath(path) {
        files.delete(path);
        return { path };
      },
      async preflightPermissions(accesses) {
        preflighted = accesses.map((access) => access.path).sort();
        throw boundaryError;
      },
    };

    await assert.rejects(
      () =>
        executeApplyPatchWithAdapter(
          envelope(
            [
              '*** Update File: a.txt',
              '@@',
              '-a',
              '+aa',
              '*** Update File: b.txt',
              '@@',
              '-b',
              '+bb',
              '',
            ].join('\n'),
          ),
          fs,
          async (_key, run) => run(),
        ),
      (error: unknown) => {
        assert.equal(error, boundaryError);
        return true;
      },
    );
    assert.equal(writes, 0);
    assert.deepEqual(preflighted, ['a.txt', 'b.txt']);
    assert.equal(files.get('a.txt'), 'a\n');
    assert.equal(files.get('b.txt'), 'b\n');
  });

  test('rethrows structured boundary errors from the first mutation without partial result', async () => {
    const files = new Map<string, string>([['a.txt', 'a\n']]);
    const boundaryError = Object.assign(new Error('sandbox boundary required'), {
      domain: 'filesystem',
      reason: 'sandbox_boundary_required',
      requiredExpansion: {
        filesystem: {
          entries: [{ path: '/tmp/workspace/a.txt', access: 'write', scope: 'exact' }],
        },
      },
    });
    const fs: ApplyPatchFsAdapter = {
      async lockKey(path) {
        return path;
      },
      async lstat(path) {
        return files.has(path) ? 'file' : 'missing';
      },
      async readText(path) {
        const content = files.get(path);
        if (content === undefined) throw new Error(`missing ${path}`);
        return content;
      },
      async writeText() {
        throw boundaryError;
      },
      async deletePath(path) {
        files.delete(path);
        return { path };
      },
    };

    await assert.rejects(
      () =>
        executeApplyPatchWithAdapter(
          envelope(['*** Update File: a.txt', '@@', '-a', '+aa', ''].join('\n')),
          fs,
          async (_key, run) => run(),
        ),
      (error: unknown) => {
        assert.equal(error, boundaryError);
        return true;
      },
    );
    assert.equal(files.get('a.txt'), 'a\n');
  });

  test('canonical path aliases cannot bypass duplicate Add tracking', async () => {
    const files = new Map<string, string>();
    const fs: ApplyPatchFsAdapter = {
      async lockKey(path) {
        return path;
      },
      async lstat(path) {
        return files.has(path) ? 'file' : 'missing';
      },
      async readText(path) {
        const content = files.get(path);
        if (content === undefined) throw new Error(`missing ${path}`);
        return content;
      },
      async writeText(path, content) {
        files.set(path, content);
        return { path, bytes: Buffer.byteLength(content, 'utf8') };
      },
      async deletePath(path) {
        files.delete(path);
        return { path };
      },
    };

    await assert.rejects(
      () =>
        executeApplyPatchWithAdapter(
          envelope(
            ['*** Add File: x.txt', '+first', '*** Add File: ./x.txt', '+second', ''].join('\n'),
          ),
          fs,
          async (_key, run) => run(),
        ),
      /already exists/i,
    );
    assert.equal(files.size, 0);
  });
});

/**
 * Build the worker `expectedTarget` the same way the real client does: the
 * entry-mode path (lstat/delete/create) resolves the parent chain and appends
 * the leaf, so a missing destination still has a valid enforcement path.
 */
async function workerExpectedTarget(
  root: string,
  operation: FilesystemWorkerOperation,
): Promise<FilesystemWorkerTarget & { displayPath: string }> {
  const { realpathAllowMissing } = await import('../path-containment.js');
  const { dirname, basename, resolve } = await import('node:path');
  const entryMode =
    operation.kind === 'delete' ||
    operation.kind === 'lstat' ||
    (operation.kind === 'write' && operation.mode === 'create');
  const canonicalCwd = await import('node:fs/promises').then((m) => m.realpath(root));
  const displayPath = resolve(canonicalCwd, operation.path);
  const access = operation.kind === 'write' || operation.kind === 'delete' ? 'write' : 'read';
  if (!entryMode) {
    const enforcementPath = await realpathAllowMissing(displayPath);
    return {
      displayPath,
      enforcementPath,
      access,
      scope: 'exact',
      targetType: await targetTypeOf(enforcementPath),
    };
  }
  const parentReal = await realpathAllowMissing(dirname(displayPath));
  const enforcementPath = resolve(parentReal, basename(displayPath));
  return {
    displayPath,
    enforcementPath,
    access,
    scope: 'exact',
    targetType: await targetTypeOf(enforcementPath),
  };
}

async function targetTypeOf(path: string): Promise<FilesystemWorkerTarget['targetType']> {
  const { lstat: lstatFn } = await import('node:fs/promises');
  try {
    const metadata = await lstatFn(path);
    if (metadata.isSymbolicLink()) return 'symlink';
    if (metadata.isFile()) return 'file';
    if (metadata.isDirectory()) return 'directory';
    return 'other';
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return 'missing';
    }
    throw error;
  }
}
