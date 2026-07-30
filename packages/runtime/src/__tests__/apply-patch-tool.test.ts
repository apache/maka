import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBuiltinTools } from '../builtin-tools.js';
import { executeApplyPatchWithAdapter, type ApplyPatchFsAdapter } from '../apply-patch-engine.js';
import { projectEffectiveProductToolSurface } from '../tool-catalog-derive.js';
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
    const names = buildBuiltinTools().map((tool) => tool.name);
    assert.ok(names.includes('Write'));
    assert.ok(names.includes('Edit'));
    assert.equal(names.includes('ApplyPatch'), false);
  });

  test('apply_patch exposes ApplyPatch and omits Write/Edit', () => {
    const names = buildBuiltinTools({ editingProtocol: 'apply_patch' }).map((tool) => tool.name);
    assert.ok(names.includes('ApplyPatch'));
    assert.equal(names.includes('Write'), false);
    assert.equal(names.includes('Edit'), false);
  });

  test('never advertises both editing protocols', () => {
    for (const protocol of ['edit_write', 'apply_patch'] as const) {
      const names = new Set(
        buildBuiltinTools({
          editingProtocol: protocol,
          includeEdit: true,
        }).map((tool) => tool.name),
      );
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
      const tools = buildBuiltinTools({ editingProtocol: 'apply_patch' });
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

      const tools = buildBuiltinTools({ editingProtocol: 'apply_patch' });
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
});

describe('product-tool surface editingProtocol', () => {
  test('projector selects exactly one editing protocol from bound tools', () => {
    const tools = buildBuiltinTools({ editingProtocol: 'all', includeEdit: true });
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

  test('builder apply_patch + default projector does not zero the editing surface', () => {
    // Double-filter regression: builder drops Write/Edit, projector default was
    // edit_write and also dropped ApplyPatch, leaving no editing tool.
    const tools = buildBuiltinTools({ editingProtocol: 'apply_patch', includeEdit: true });
    const surface = projectEffectiveProductToolSurface({
      host: 'cli',
      tools,
      policy: { economy: false },
    });
    assert.ok(surface.toolNames.has('ApplyPatch'));
    assert.equal(surface.toolNames.has('Write'), false);
    assert.equal(surface.toolNames.has('Edit'), false);
    assert.equal(surface.identity.policy.editingProtocol, 'apply_patch');
  });
});

describe('shared ApplyPatch engine partial move failure', () => {
  test('reports partial=true and completed destination when source delete fails', async () => {
    const files = new Map<string, string>([['src.txt', 'hello\n']]);
    const fs: ApplyPatchFsAdapter = {
      async lockKey(path) {
        return path;
      },
      async pathExists(path) {
        return files.has(path);
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
      async pathExists(path) {
        return files.has(path);
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
      async pathExists(path) {
        return files.has(path);
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
});
