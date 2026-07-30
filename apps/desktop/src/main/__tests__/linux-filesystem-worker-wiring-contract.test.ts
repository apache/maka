import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildDesktopBuiltinTools } from '../desktop-builtin-tools.js';
import { test } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../../');

test('CLI and Desktop create the filesystem worker only when the builtin sandbox is usable', async () => {
  const sources = await Promise.all([
    readFile(resolve(REPO_ROOT, 'packages/cli/src/runtime-bootstrap.ts'), 'utf8'),
    readFile(resolve(REPO_ROOT, 'apps/desktop/src/main/tool-assembly.ts'), 'utf8'),
  ]);

  for (const source of sources) {
    assert.match(
      source,
      /const filesystemWorkerLaunchSpecProvider\s*=\s*sandboxManager\s*&&\s*isBuiltinFilesystemWorkerSandboxAvailable\(\)\s*\?\s*createFilesystemWorkerLaunchSpecProvider\(/,
    );
    assert.doesNotMatch(
      source,
      /filesystemWorkerLaunchSpecProvider\s*=\s*process\.platform\s*===\s*'darwin'/,
    );
  }
});

test('Desktop exposes Edit only when a filesystem worker is available', () => {
  const withoutWorker = buildDesktopBuiltinTools({});
  const withWorker = buildDesktopBuiltinTools({ filesystemWorker: {} as never });

  assert.equal(withoutWorker.some((tool) => tool.name === 'Edit'), false);
  assert.equal(withWorker.some((tool) => tool.name === 'Edit'), true);
});
