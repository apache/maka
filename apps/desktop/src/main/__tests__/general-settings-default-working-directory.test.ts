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

/**
 * The default working directory is a client-owned, local-only preference. A
 * Host-backed Runtime Host cannot own it and its ProjectRootController never
 * receives `defaultWorkingDirectory`, so offering the control there would let a
 * user save a path the target is incapable of using.
 *
 * These tests pin two things: the capability gate agrees with the boundary the
 * main process uses to build `setLocalDefault`, and the save lands in the
 * client-owned (per-machine) `projects` section rather than anything
 * Host-shared.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UpdateAppSettingsInput } from '@maka/core/settings';
import { runtimeHostProfileUsesHostWorkspace } from '@maka/runtime-host/profile-kind';
import type { RuntimeHostProfileKind } from '@maka/runtime-host/profile-kind';
import {
  canSetLocalDefaultWorkingDirectory,
  resolveDefaultWorkingDirectoryPatch,
} from '../../renderer/platform/desktop/settings-surface-capabilities.js';

const CHOSEN_DIRECTORY = '/Users/example/picked';

const PROFILE_KINDS: readonly RuntimeHostProfileKind[] = ['local', 'environment', 'remote'];

test('only a client-owned workspace may set a local default directory', () => {
  assert.equal(canSetLocalDefaultWorkingDirectory('local'), true);
  assert.equal(canSetLocalDefaultWorkingDirectory('environment'), false);
  assert.equal(canSetLocalDefaultWorkingDirectory('remote'), false);
});

test('the gate tracks the same boundary the main process derives setLocalDefault from', () => {
  // `runtime-host-boot.ts` builds `setLocalDefault: !usesHostWorkspace`. If a new
  // profile kind ever disagrees with that, the control would offer to save a
  // path its target cannot use.
  for (const kind of PROFILE_KINDS) {
    assert.equal(
      canSetLocalDefaultWorkingDirectory(kind),
      !runtimeHostProfileUsesHostWorkspace(kind),
      `gate disagrees with the main-process capability for ${kind}`,
    );
  }
});

test('an unknown target cannot set the directory', () => {
  // No selected Runtime Host means no answer yet; staying hidden beats guessing.
  assert.equal(canSetLocalDefaultWorkingDirectory(undefined), false);
});

test('choosing a folder patches the client-owned Project preferences', async () => {
  const { patches, pickerCalls } = await runRowAction('choose', CHOSEN_DIRECTORY);

  assert.deepEqual(patches, [{ projects: { defaultWorkingDirectory: CHOSEN_DIRECTORY } }]);
  assert.equal(pickerCalls, 1);
});

test('a cancelled picker is not a request to clear the directory', async () => {
  const { patches, pickerCalls } = await runRowAction('choose', undefined);

  assert.equal(pickerCalls, 1);
  assert.deepEqual(patches, []);
});

test('clearing sends an undefined directory and never opens a picker', async () => {
  const { patches, pickerCalls } = await runRowAction('clear', CHOSEN_DIRECTORY);

  assert.deepEqual(patches, [{ projects: { defaultWorkingDirectory: undefined } }]);
  assert.equal(pickerCalls, 0);
});

/**
 * Drives the row's real decision function.
 *
 * `GeneralDefaultsCard` renders the row inline and reaches the outside world only
 * through the `onSaveWorkingDirectory` callback the Settings surface passes in.
 * `resolveDefaultWorkingDirectoryPatch` is the decision behind that callback, so
 * exercising it pins what the row actually owns: which patch it sends, and
 * whether it opens a picker at all.
 */
async function runRowAction(
  action: 'choose' | 'clear',
  chosenDirectory: string | undefined,
): Promise<{ patches: UpdateAppSettingsInput[]; pickerCalls: number }> {
  const patches: UpdateAppSettingsInput[] = [];
  let pickerCalls = 0;

  const patch = await resolveDefaultWorkingDirectoryPatch(action, async () => {
    pickerCalls += 1;
    return chosenDirectory;
  });
  if (patch) patches.push(patch);

  return { patches, pickerCalls };
}
