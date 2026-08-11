import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { ProjectRecord } from '@maka/core/project';
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

function makeProject(id: string, path: string): ProjectRecord {
  return {
    id,
    name: id,
    locations: [
      {
        path,
        isWorktree: false,
      },
    ],
    preferredPath: path,
    available: true,
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
