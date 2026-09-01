/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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

// P2a: the optional default directory must never be a precondition of Project
// recovery. A rejecting callback is an unset preference at the fallback
// boundary, so an existing Project ID still comes back and the no-Project case
// degrades to the fallback roots instead of rejecting.
test('a rejecting default-directory callback does not block Project recovery', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-default-working-directory-rejects-'));
  const fallback = join(base, 'fallback');
  await mkdir(fallback);
  await writeFile(
    join(base, 'project-preferences.json'),
    JSON.stringify({ version: 1, selections: { 'root-a': 'project-a' } }),
  );
  const rejecting = async (): Promise<string | undefined> => {
    throw new Error('settings.json is malformed');
  };
  try {
    assert.deepEqual(await controller(base, fallback, 'root-a', rejecting).currentSelection(), {
      projectId: 'project-a',
      path: fallback,
    });

    assert.deepEqual(await controller(base, fallback, 'root-b', rejecting).currentSelection(), {
      projectId: undefined,
      path: fallback,
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// P1: `setSelection()` writes the selection synchronously, so it can land while
// either await inside `currentSelection()` is still pending. The continuation
// must not commit its stale unassociated result over that newer Project.
test('a selection made during resolution is not overwritten by the pending default', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-default-working-directory-race-'));
  const fallback = join(base, 'fallback');
  const configured = join(base, 'agent');
  const projectPath = join(base, 'project');
  await Promise.all([mkdir(fallback), mkdir(configured), mkdir(projectPath)]);
  try {
    let releaseDefault = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseDefault = resolve;
    });
    const deferred = controller(base, fallback, 'root-a', async () => {
      await gate;
      return configured;
    });
    const pending = deferred.currentSelection();
    await deferred.setSelection('project-a', projectPath);
    releaseDefault();

    assert.deepEqual(await pending, { projectId: 'project-a', path: projectPath });
    assert.deepEqual(await deferred.currentSelection(), {
      projectId: 'project-a',
      path: projectPath,
    });

    // The same invariant across the initial-preference await, which resolves
    // before the default directory is ever consulted.
    const early = controller(base, fallback, 'root-b', async () => configured);
    const earlyPending = early.currentSelection();
    await early.setSelection('project-b', projectPath);
    assert.deepEqual(await earlyPending, { projectId: 'project-b', path: projectPath });
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
