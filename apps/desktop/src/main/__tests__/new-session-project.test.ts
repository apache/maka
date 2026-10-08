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
import { test } from 'node:test';
import { resolveDesktopSessionWorkspace } from '../new-session-project.js';

test('registers an explicit unassociated Desktop directory as a Project target', async () => {
  assert.deepEqual(
    await resolveDesktopSessionWorkspace(
      { cwd: '/workspace' },
      selection(),
      { register: async () => ({ id: 'project-1' }) as never },
      { allocateDedicatedDirectory: unexpected },
    ),
    { kind: 'project', projectId: 'project-1' },
  );
});

test('preserves an explicit no-Project directory as a Host-path target', async () => {
  assert.deepEqual(
    await resolveDesktopSessionWorkspace(
      { cwd: '/standalone', projectId: null },
      selection(),
      { register: unexpected },
      { allocateDedicatedDirectory: unexpected },
    ),
    { kind: 'host_path', path: '/standalone' },
  );
});

test('uses an explicit Project identity without trusting the Client directory', async () => {
  const selected: unknown[] = [];
  const projectSelection = {
    ...selection(),
    select: async (projectId: unknown) => {
      selected.push(projectId);
      return { project: { id: String(projectId) }, path: '/unexpected' };
    },
  };
  assert.deepEqual(
    await resolveDesktopSessionWorkspace(
      { cwd: '/stale/client/path', projectId: 'project-1' },
      projectSelection,
      { register: unexpected },
      { allocateDedicatedDirectory: unexpected },
    ),
    { kind: 'project', projectId: 'project-1' },
  );
  assert.deepEqual(selected, [], 'an explicit draft Project does not change Host selection');
});

test('uses the configured default before the current Project preference', async () => {
  assert.deepEqual(
    await resolveDesktopSessionWorkspace(
      {},
      selection({
        current: { projectId: 'current', path: '/current' },
        defaultProjectId: 'default',
      }),
      { register: unexpected },
      { allocateDedicatedDirectory: unexpected },
    ),
    { kind: 'project', projectId: 'default' },
  );
});

test('falls back to the current preference when the configured default is stale', async () => {
  assert.deepEqual(
    await resolveDesktopSessionWorkspace(
      {},
      selection({
        current: { projectId: 'current', path: '/current' },
        defaultProjectId: 'missing',
        unavailableIds: ['missing'],
      }),
      { register: unexpected },
      { allocateDedicatedDirectory: unexpected },
    ),
    { kind: 'project', projectId: 'current' },
  );
});

test('allocates a task directory when no Project preference exists', async () => {
  assert.deepEqual(
    await resolveDesktopSessionWorkspace(
      {},
      selection({ current: { projectId: null, path: '/standalone' } }),
      { register: unexpected },
      { allocateDedicatedDirectory: async () => '/tasks/task-new' },
    ),
    { kind: 'host_path', path: '/tasks/task-new' },
  );
});

test('allocates a dedicated directory for a projectless task on an implicit path', async () => {
  const allocated: string[] = [];
  const options = {
    allocateDedicatedDirectory: async () => {
      allocated.push('x');
      return '/tasks/task-a1b2c3d4';
    },
  };
  assert.deepEqual(
    await resolveDesktopSessionWorkspace(
      { projectId: null },
      { ...selection(), current: unexpected },
      { register: unexpected },
      options,
    ),
    { kind: 'host_path', path: '/tasks/task-a1b2c3d4' },
  );
  assert.deepEqual(
    await resolveDesktopSessionWorkspace(
      {},
      selection({ current: { projectId: undefined, path: '/' } }),
      { register: unexpected },
      options,
    ),
    { kind: 'host_path', path: '/tasks/task-a1b2c3d4' },
  );
  assert.equal(allocated.length, 2);
});

test('an explicit no-Project directory stays explicit and never allocates', async () => {
  assert.deepEqual(
    await resolveDesktopSessionWorkspace(
      { cwd: '/standalone', projectId: null },
      selection(),
      { register: unexpected },
      { allocateDedicatedDirectory: unexpected },
    ),
    { kind: 'host_path', path: '/standalone' },
  );
});

test('propagates allocation failure instead of inheriting the current Host path', async () => {
  const failure = new Error('Cannot allocate task directory');
  for (const input of [{}, { projectId: null }]) {
    await assert.rejects(
      resolveDesktopSessionWorkspace(
        input,
        selection({ current: { projectId: null, path: '/old-fallback' } }),
        { register: unexpected },
        { allocateDedicatedDirectory: async () => { throw failure; } },
      ),
      (error) => error === failure,
    );
  }
});

test('requires a Host Project for remote session creation', async () => {
  await assert.rejects(
    () =>
      resolveDesktopSessionWorkspace(
        { cwd: '/client/path' },
        selection(),
        { register: unexpected },
        { allowHostPath: false, allocateDedicatedDirectory: unexpected },
      ),
    /Select a project from the remote Runtime Host/,
  );
  assert.deepEqual(
    await resolveDesktopSessionWorkspace(
      { cwd: '/client/path', projectId: 'host-project' },
      selection(),
      { register: unexpected },
      { allowHostPath: false, allocateDedicatedDirectory: unexpected },
    ),
    { kind: 'project', projectId: 'host-project' },
  );
});

function selection(
  options: {
    readonly current?: { readonly projectId: string | null | undefined; readonly path: string };
    readonly defaultProjectId?: string;
    readonly unavailableIds?: readonly string[];
  } = {},
) {
  return {
    current: async () => options.current ?? { projectId: undefined, path: '/workspace' },
    select: async (projectId: unknown) => {
      const id = String(projectId);
      return {
        project: options.unavailableIds?.includes(id) ? null : { id },
        path: `/${id}`,
      };
    },
    defaultProjectId: async () => options.defaultProjectId,
  };
}

async function unexpected(): Promise<never> {
  throw new Error('Unexpected call');
}
