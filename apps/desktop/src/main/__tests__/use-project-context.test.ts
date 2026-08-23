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
import { afterEach, test } from 'node:test';
import { act, createElement } from 'react';
import { build } from 'esbuild';
import type { ProjectRecord } from '@maka/core/project';
import type * as ProjectContext from '../../renderer/use-project-context.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

const NO_PROJECT_CAPABILITIES = {
  chooseClientDirectory: false,
  chooseHostDirectory: false,
  selectNoProject: false,
  setLocalDefault: false,
  viewClientPath: false,
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test('discards a pending Project projection after the default Host changes', async () => {
  const projectContext = await importProjectContext();
  const { root } = installReactRenderer();
  const hostA = { profileId: 'profile-a', hostId: 'host-a' };
  const hostB = { profileId: 'profile-b', hostId: 'host-b' };
  let defaultHost = hostA;
  let defaultHostReads = 0;
  const contextStarted = deferred<void>();
  const commitGuardChecked = deferred<void>();
  const pendingContext = deferred<{
    snapshot: { projects: ProjectRecord[]; capabilities: typeof NO_PROJECT_CAPABILITIES };
    info: {
      projectId: string;
      projectPath: string;
      projectGit: { isGitRepo: boolean };
    };
  }>();
  (globalThis.window as unknown as { maka: unknown }).maka = {
    runtimeHostProfiles: {
      getDefaultHost: async () => {
        defaultHostReads += 1;
        if (defaultHostReads === 2) commitGuardChecked.resolve();
        return defaultHost;
      },
    },
    projects: {
      getDefaultContext: async (host: unknown) => {
        assert.deepEqual(host, hostA);
        contextStarted.resolve();
        return pendingContext.promise;
      },
      subscribeChanges: () => () => {},
      getLocalSnapshot: async () => ({
        projects: [],
        capabilities: NO_PROJECT_CAPABILITIES,
      }),
      subscribeLocalChanges: () => () => {},
    },
  };
  let projects: ProjectRecord[] = [];
  let selectedProjectId: string | null | undefined;

  function Probe() {
    const context = projectContext.useAppShellProjectContext({
      uiLocale: 'en',
      rendererMountedRef: { current: true },
      onProjectSelected: () => {},
      toastApi: { success: () => {}, error: () => {} },
    });
    projects = context.projects;
    selectedProjectId = context.selectedProjectId;
    return null;
  }

  await act(async () => {
    root.render(createElement(Probe));
  });
  await contextStarted.promise;

  defaultHost = hostB;
  await act(async () => {
    pendingContext.resolve({
      snapshot: {
        projects: [{ id: 'project-a', name: 'Project A', locations: [], available: true }],
        capabilities: NO_PROJECT_CAPABILITIES,
      },
      info: {
        projectId: 'project-a',
        projectPath: '/host-a/project',
        projectGit: { isGitRepo: false },
      },
    });
    await commitGuardChecked.promise;
  });

  assert.deepEqual(projects, []);
  assert.equal(selectedProjectId, undefined);
});

afterEach(() => {
  cleanupFakeDom();
});

async function importProjectContext(): Promise<typeof ProjectContext> {
  const outdir = await mkdtemp(resolve(REPO_ROOT, 'apps/desktop/dist/main/__tests__/project-context-'));
  const outfile = resolve(outdir, 'use-project-context.mjs');
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [resolve(REPO_ROOT, 'apps/desktop/src/renderer/use-project-context.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['react'],
    logLevel: 'silent',
  });
  return (await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)) as typeof ProjectContext;
}
