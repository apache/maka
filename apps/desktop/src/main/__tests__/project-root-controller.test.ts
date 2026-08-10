import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProjectRootController } from '../project-root-controller.js';

test('persists Project preferences by Runtime Host root identity', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-preference-'));
  const fallback = join(base, 'fallback');
  await mkdir(fallback);
  const preferenceFile = join(base, 'project-preferences.json');
  try {
    const first = controller(base, fallback, 'root-a');
    first.setSelection('project-a', fallback);
    await waitForPreference(preferenceFile, 'root-a', 'project-a');

    const second = controller(base, fallback, 'root-b');
    second.setSelection('project-b', fallback);
    await waitForPreference(preferenceFile, 'root-b', 'project-b');

    assert.equal((await controller(base, fallback, 'root-a').currentSelection()).projectId, 'project-a');
    assert.equal((await controller(base, fallback, 'root-b').currentSelection()).projectId, 'project-b');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('migrates the legacy path selection once and removes the legacy file', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-preference-migration-'));
  const project = join(base, 'project');
  await mkdir(project);
  const legacy = join(base, 'last-project-path.json');
  await writeFile(legacy, JSON.stringify({ projectId: 'project-1', projectPath: project }));
  try {
    const selection = await controller(base, project, 'root-a').currentSelection();
    assert.equal(selection.projectId, 'project-1');
    assert.equal(selection.path, project);
    await assert.rejects(() => readFile(legacy), /ENOENT/);
    await waitForPreference(join(base, 'project-preferences.json'), 'root-a', 'project-1');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('keeps a legacy path selection until it can be represented by a Project id', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-preference-path-migration-'));
  const fallback = join(base, 'fallback');
  const project = join(base, 'project');
  await mkdir(fallback);
  await mkdir(project);
  const legacy = join(base, 'last-project-path.json');
  await writeFile(legacy, JSON.stringify({ projectPath: project }));
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.deepEqual(await controller(base, fallback, 'root-a').currentSelection(), {
        projectId: undefined,
        path: project,
      });
    }
    assert.equal(JSON.parse(await readFile(legacy, 'utf8')).projectPath, project);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('does not reuse a preference from another Runtime Host root', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-preference-scope-'));
  const fallback = join(base, 'fallback');
  await mkdir(fallback);
  await writeFile(
    join(base, 'project-preferences.json'),
    JSON.stringify({ version: 1, selections: { 'root-a': 'project-a' } }),
  );
  try {
    assert.deepEqual(await controller(base, fallback, 'root-b').currentSelection(), {
      projectId: undefined,
      path: fallback,
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

function controller(base: string, fallback: string, rootId: string) {
  return createProjectRootController({
    rootId,
    preferenceFile: join(base, 'project-preferences.json'),
    legacySelectionFile: join(base, 'last-project-path.json'),
    fallbackRoots: () => [fallback],
  });
}

async function waitForPreference(
  file: string,
  rootId: string,
  projectId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as {
        selections?: Record<string, string>;
      };
      if (parsed.selections?.[rootId] === projectId) return;
    } catch {
      // The best-effort write may still be pending.
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Preference was not persisted for ${rootId}`);
}
