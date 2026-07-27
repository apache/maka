import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { ProjectRecord } from '@maka/core';
import { build } from 'esbuild';
import type * as ProjectActions from '../../renderer/app-shell-project-actions.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

test('relink adopts the surviving project when the selected duplicate is merged', async () => {
  const actionsModule = await importProjectActions();
  const original = makeProject('project-original', '/workspace/new');
  const selectedProjectIds: Array<string | null | undefined> = [];
  const previousWindow = globalThis.window;
  globalThis.window = {
    maka: {
      projects: {
        relink: async () => ({ ok: true, project: original }),
        list: async () => [original],
      },
    },
  } as unknown as Window & typeof globalThis;

  try {
    const actions = actionsModule.createAppShellProjectActions({
      uiLocale: 'zh',
      projectPickerPendingRef: { current: false },
      projectPickerRequestRef: { current: 0 },
      rendererMountedRef: { current: true },
      setAppInfo: () => {},
      setSessionProjectInfo: () => {},
      setProjectPickerPending: () => {},
      setBranchPending: () => {},
      setBranchList: () => {},
      setProjects: () => {},
      setSelectedProjectId: (value) => {
        selectedProjectIds.push(
          typeof value === 'function' ? value('project-duplicate') : value,
        );
      },
      selectedProjectId: 'project-duplicate',
      projects: [original, makeProject('project-duplicate', '/workspace/new')],
      projectInfo: {
        projectPath: '/workspace/new',
        projectGit: { isGitRepo: false },
      },
      onProjectSelected: () => {},
      toastApi: {
        success: () => {},
        error: () => {},
      },
    });

    await actions.relinkProject(original.id);

    assert.equal(selectedProjectIds.at(-1), original.id);
  } finally {
    globalThis.window = previousWindow;
  }
});

test('preparing a default task preserves an explicit no-project selection', async () => {
  const actionsModule = await importProjectActions();
  const project = makeProject('project-1', '/workspace/project');
  let selectCalls = 0;
  const previousWindow = globalThis.window;
  globalThis.window = {
    maka: {
      projects: {
        list: async () => [project],
        select: async () => {
          selectCalls += 1;
          return { project, path: project.preferredPath };
        },
      },
      app: {
        resolveProjectGitInfo: async () => ({
          ok: true,
          projectPath: project.preferredPath,
          projectGit: { isGitRepo: false },
        }),
      },
    },
  } as unknown as Window & typeof globalThis;

  try {
    const actions = actionsModule.createAppShellProjectActions({
      uiLocale: 'zh',
      projectPickerPendingRef: { current: false },
      projectPickerRequestRef: { current: 0 },
      rendererMountedRef: { current: true },
      setAppInfo: () => {},
      setSessionProjectInfo: () => {},
      setProjectPickerPending: () => {},
      setBranchPending: () => {},
      setBranchList: () => {},
      setProjects: () => {},
      setSelectedProjectId: () => {},
      selectedProjectId: null,
      projects: [project],
      projectInfo: null,
      onProjectSelected: () => {},
      toastApi: {
        success: () => {},
        error: () => {},
      },
    });

    assert.equal(await actions.prepareDefaultProject(), true);
    assert.equal(selectCalls, 0);
  } finally {
    globalThis.window = previousWindow;
  }
});

test('selecting no project clears the persisted project default', async () => {
  const actionsModule = await importProjectActions();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new Map([
    [
      'maka-composer-defaults-v1',
      JSON.stringify({ projectPath: '/workspace/old-project', model: null }),
    ],
  ]);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });

  try {
    const actions = actionsModule.createAppShellProjectActions({
      uiLocale: 'zh',
      projectPickerPendingRef: { current: false },
      projectPickerRequestRef: { current: 0 },
      rendererMountedRef: { current: true },
      setAppInfo: () => {},
      setSessionProjectInfo: () => {},
      setProjectPickerPending: () => {},
      setBranchPending: () => {},
      setBranchList: () => {},
      setProjects: () => {},
      setSelectedProjectId: () => {},
      selectedProjectId: 'project-1',
      projects: [],
      projectInfo: null,
      onProjectSelected: () => {},
      toastApi: {
        success: () => {},
        error: () => {},
      },
    });

    actions.selectNoProject();

    assert.equal(
      JSON.parse(storage.get('maka-composer-defaults-v1') ?? '{}').projectPath,
      null,
    );
  } finally {
    if (previousLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  }
});

function makeProject(id: string, path: string): ProjectRecord {
  return {
    id,
    name: id,
    kind: 'folder',
    locations: [
      {
        path,
        isWorktree: false,
        addedAt: 1,
        lastUsedAt: 1,
      },
    ],
    preferredPath: path,
    available: true,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: 1,
  };
}

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
