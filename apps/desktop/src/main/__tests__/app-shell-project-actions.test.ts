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
import { mkdir, mkdtemp } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import type { ProjectRecord } from '@maka/core/project';
import type * as ProjectActions from '../../renderer/app-shell-project-actions.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const NO_PROJECT_CAPABILITIES = {
  chooseClientDirectory: false,
  chooseHostDirectory: false,
  selectNoProject: false,
  setLocalDefault: false,
  viewClientPath: false,
} as const;

function createTestProjectActions(
  actionsModule: typeof ProjectActions,
  overrides: Partial<Parameters<typeof ProjectActions.createAppShellProjectActions>[0]> = {},
) {
  return actionsModule.createAppShellProjectActions({
    uiLocale: 'en',
    projectPickerPendingRef: { current: false },
    projectPickerRequestRef: { current: 0 },
    rendererMountedRef: { current: true },
    setProjectPickerPending: () => {},
    refreshDefaultProjectState: async () => [],
    selectedProjectId: null,
    projects: [],
    projectCapabilities: NO_PROJECT_CAPABILITIES,
    onProjectSelected: () => {},
    toastApi: { success: () => {}, error: () => {}, confirm: async () => true },
    ...overrides,
  });
}

test('remote Project capabilities do not dispatch Client-local actions', async () => {
  const actionsModule = await importProjectActions();
  let clientActionCalls = 0;
  const previousWindow = globalThis.window;
  globalThis.window = {
    maka: {
      projects: {
        add: async () => {
          clientActionCalls += 1;
          return { ok: false, reason: 'cancelled' };
        },
        select: async () => {
          clientActionCalls += 1;
          return { project: null, path: '' };
        },
        relink: async () => {
          clientActionCalls += 1;
          return { ok: false, reason: 'cancelled' };
        },
      },
    },
  } as unknown as Window & typeof globalThis;

  try {
    const actions = createTestProjectActions(actionsModule);

    assert.equal(await actions.addProject(), null);
    await actions.selectNoProject();
    assert.equal(await actions.relinkProject('remote'), null);
    assert.equal(clientActionCalls, 0);
  } finally {
    globalThis.window = previousWindow;
  }
});

test('Project errors preserve the Host authority of the failed operation', async () => {
  const actionsModule = await importProjectActions();
  const previousWindow = globalThis.window;
  const diagnosticTargets: unknown[] = [];
  const toastApi = {
    success: () => {},
    error: (_title: string, _description?: string, _details?: string, target?: unknown) => {
      diagnosticTargets.push(target);
    },
    confirm: async () => false,
  };
  globalThis.window = {
    maka: {
      runtimeHostProfiles: {
        getDefaultHost: async () => ({ profileId: 'default-profile', hostId: 'default-host' }),
      },
      app: {
        openPath: async () => {
          throw new Error('unavailable');
        },
      },
    },
  } as unknown as Window & typeof globalThis;

  try {
    const actions = createTestProjectActions(actionsModule, {
      sessionId: 'session-key',
      toastApi,
    });

    await actions.openWorkspaceFolder();
    await actions.openProjectFolder();
    await createTestProjectActions(actionsModule, {
      toastApi,
    }).openProjectFolder();

    assert.deepEqual(diagnosticTargets, [
      { profileId: 'default-profile' },
      { sessionId: 'session-key' },
      { profileId: 'default-profile' },
    ]);
  } finally {
    globalThis.window = previousWindow;
  }
});

test('a Project mutation refresh stays bound to the operation Host', async () => {
  const actionsModule = await importProjectActions();
  const previousWindow = globalThis.window;
  const host = { profileId: 'profile-a', hostId: 'host-a' };
  let renamedOnHost: unknown;
  let refreshedHost: unknown;
  globalThis.window = {
    maka: {
      runtimeHostProfiles: {
        getDefaultHost: async () => host,
      },
      projects: {
        rename: async (_projectId: string, _name: string, host: unknown) => {
          renamedOnHost = host;
        },
      },
    },
  } as unknown as Window & typeof globalThis;

  try {
    const actions = createTestProjectActions(actionsModule, {
      refreshDefaultProjectState: async (operationHost) => {
        refreshedHost = operationHost;
        return [];
      },
    });

    await actions.renameProject('project-1', 'Renamed');

    assert.deepEqual(renamedOnHost, host);
    assert.deepEqual(refreshedHost, host);
  } finally {
    globalThis.window = previousWindow;
  }
});

test('Add on an archived directory: Host selection truth and UI claims must agree', async () => {
  const actionsModule = await importProjectActions();
  const previousWindow = globalThis.window;
  const catalog = new Map<string, ProjectRecord>([
    ['project-a', { id: 'project-a', name: 'A', preferredPath: '/tmp/a', available: true } as ProjectRecord],
  ]);
  // First-principles ground truth: the Host owns the selected project.
  const host = { selectedProjectId: 'project-a' as string | null };
  const successClaims: string[] = [];
  const toastApi = {
    success: (_title: string, description?: string) => {
      successClaims.push(description ?? '');
    },
    error: () => {},
    confirm: async () => true,
  };
  const fakeWindow = (hostSelects: boolean) => ({
    maka: {
      runtimeHostProfiles: {
        getDefaultHost: async () => ({ profileId: 'default-profile', hostId: 'default-host' }),
      },
      projects: {
        add: async () => ({
          ok: false as const,
          reason: 'archived' as const,
          projectId: 'project-b',
        }),
        restore: async (projectId: string) => {
          const restored = {
            id: projectId,
            name: 'B',
            preferredPath: '/tmp/b',
            available: true,
          } as ProjectRecord;
          catalog.set(projectId, restored);
          return restored;
        },
        select: async (projectId: string | null) => {
          if (!hostSelects) return { project: null, path: '' };
          host.selectedProjectId = projectId;
          const selected = projectId === null ? null : catalog.get(projectId) ?? null;
          return { project: selected, path: selected?.preferredPath ?? '' };
        },
      },
      app: {
        resolveProjectGitInfo: async (projectPath: string) => ({
          ok: true as const,
          projectPath,
          projectGit: { isGitRepo: false },
        }),
      },
    },
  });

  try {
    const actions = createTestProjectActions(actionsModule, {
      projectCapabilities: { ...NO_PROJECT_CAPABILITIES, chooseClientDirectory: true },
      refreshDefaultProjectState: async () => [],
      toastApi,
    });

    // User path: A selected, Add picks archived B, user confirms restore.
    globalThis.window = fakeWindow(true) as unknown as Window & typeof globalThis;
    const project = await actions.addProject();

    // Truth: the Host now runs B, not A.
    assert.equal(host.selectedProjectId, 'project-b');
    // Claims: the returned record and the success toast say the same thing.
    assert.equal(project?.id, 'project-b');
    assert.deepEqual(successClaims, ['B']);

    // Counterfactual: the Host refuses selection, so truth stays A.
    host.selectedProjectId = 'project-a';
    catalog.delete('project-b');
    successClaims.length = 0;
    globalThis.window = fakeWindow(false) as unknown as Window & typeof globalThis;

    assert.equal(await actions.addProject(), null);
    assert.equal(host.selectedProjectId, 'project-a');
    assert.deepEqual(successClaims, [], 'no success claim when Host truth did not change');
  } finally {
    globalThis.window = previousWindow;
  }
});

async function importProjectActions(): Promise<typeof ProjectActions> {
  const outdir = await mkdtemp(resolve(REPO_ROOT, 'apps/desktop/dist/main/__tests__/project-actions-'));
  const outfile = resolve(outdir, 'app-shell-project-actions.mjs');
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [resolve(REPO_ROOT, 'apps/desktop/src/renderer/app-shell-project-actions.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  return (await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)) as typeof ProjectActions;
}
