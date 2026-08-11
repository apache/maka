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
    await first.setSelection('project-a', fallback);

    const second = controller(base, fallback, 'root-b');
    await second.setSelection('project-b', fallback);

    assert.equal((await controller(base, fallback, 'root-a').currentSelection()).projectId, 'project-a');
    assert.equal((await controller(base, fallback, 'root-b').currentSelection()).projectId, 'project-b');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('serializes rapid selections without losing another Runtime Host root', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-preference-concurrency-'));
  const fallback = join(base, 'fallback');
  await mkdir(fallback);
  const preferenceFile = join(base, 'project-preferences.json');
  try {
    const first = controller(base, fallback, 'root-a');
    const second = controller(base, fallback, 'root-b');
    await Promise.all([
      first.setSelection('project-a-1', fallback),
      second.setSelection('project-b', fallback),
      first.setSelection('project-a-2', fallback),
    ]);
    assert.deepEqual(JSON.parse(await readFile(preferenceFile, 'utf8')).selections, {
      'root-a': 'project-a-2',
      'root-b': 'project-b',
    });
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
    fallbackRoots: () => [fallback],
  });
}
