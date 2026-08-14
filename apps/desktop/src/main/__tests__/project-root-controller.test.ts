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

test('uses the configured working directory dynamically when no Project is selected', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-default-working-directory-'));
  const fallback = join(base, 'fallback');
  const firstDefault = join(base, 'agent-a');
  const secondDefault = join(base, 'agent-b');
  await Promise.all([mkdir(fallback), mkdir(firstDefault), mkdir(secondDefault)]);
  let configured = firstDefault;
  const current = controller(base, fallback, 'root-a', async () => configured);
  try {
    assert.equal(await current.current(), firstDefault);
    configured = secondDefault;
    assert.equal(await current.current(), secondDefault);

    await current.setSelection('project-a', fallback);
    configured = firstDefault;
    assert.equal(await current.current(), fallback);

    await current.setSelection(null, fallback);
    assert.equal(await current.current(), firstDefault);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('falls back when the configured working directory is unavailable', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-default-working-directory-missing-'));
  const fallback = join(base, 'fallback');
  await mkdir(fallback);
  try {
    assert.equal(
      await controller(base, fallback, 'root-a', async () => join(base, 'missing')).current(),
      fallback,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

function controller(
  base: string,
  fallback: string,
  rootId: string,
  defaultWorkingDirectory?: () => Promise<string | undefined>,
) {
  return createProjectRootController({
    rootId,
    preferenceFile: join(base, 'project-preferences.json'),
    fallbackRoots: () => [fallback],
    defaultWorkingDirectory,
  });
}
