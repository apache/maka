import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBuiltinTools } from '../builtin-tools.js';
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
