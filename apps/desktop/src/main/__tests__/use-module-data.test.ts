import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, test } from 'node:test';
import { act, createElement } from 'react';
import { build } from 'esbuild';
import type * as ModuleData from '../../renderer/use-module-data.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}

test('keeps stale same-Host module refreshes from changing state or reporting errors', async () => {
  const moduleData = await importModuleData();
  const { root } = installReactRenderer();
  const host = { profileId: 'profile-a', hostId: 'host-a' };
  type Projection = 'skills' | 'managedSkillSources' | 'bundledSkillCatalog' | 'scheduledTasks';
  let activeRead: {
    projection: Projection;
    calls: number;
    started: ReturnType<typeof deferred<void>>;
    pending: ReturnType<typeof deferred<Array<{ id: string }>>>;
  } | undefined;
  const read = async (projection: Projection, operationHost: unknown) => {
    assert.deepEqual(operationHost, host);
    assert.equal(activeRead?.projection, projection);
    if (!activeRead) throw new Error('No projection read is active');
    activeRead.calls += 1;
    if (activeRead.calls === 1) {
      activeRead.started.resolve();
      return activeRead.pending.promise;
    }
    return [{ id: `${projection}-new` }];
  };
  (globalThis.window as unknown as { maka: unknown }).maka = {
    runtimeHostProfiles: {
      getDefaultHost: async () => host,
    },
    skills: {
      list: (operationHost: unknown) => read('skills', operationHost),
      sources: {
        list: (operationHost: unknown) => read('managedSkillSources', operationHost),
      },
      catalog: {
        list: (operationHost: unknown) => read('bundledSkillCatalog', operationHost),
      },
    },
    scheduledTasks: {
      list: (operationHost: unknown) => read('scheduledTasks', operationHost),
    },
  };
  let current: ReturnType<typeof moduleData.useAppShellModuleData> | undefined;
  let renderRevision = 0;
  const errors: string[] = [];

  function Probe(_props: { revision: number }) {
    current = moduleData.useAppShellModuleData({
      uiLocale: 'en',
      isSkillsSurfaceActive: () => true,
      isScheduledTasksSurfaceActive: () => true,
      toastApi: {
        success: () => {},
        error: (title) => errors.push(title),
        confirm: async () => true,
      },
    });
    return null;
  }

  await act(async () => {
    root.render(createElement(Probe, { revision: 0 }));
  });

  const projections: Array<{
    projection: Projection;
    refresh(value: NonNullable<typeof current>): Promise<void>;
    values(value: NonNullable<typeof current>): readonly { id: string }[];
  }> = [
    {
      projection: 'skills',
      refresh: (value) => value.refreshSkills(),
      values: (value) => value.skills,
    },
    {
      projection: 'managedSkillSources',
      refresh: (value) => value.refreshManagedSkillSources(),
      values: (value) => value.managedSkillSources,
    },
    {
      projection: 'bundledSkillCatalog',
      refresh: (value) => value.refreshBundledSkillCatalog(),
      values: (value) => value.bundledSkillCatalog,
    },
    {
      projection: 'scheduledTasks',
      refresh: (value) => value.refreshScheduledTasks(),
      values: (value) => value.scheduledTasks,
    },
  ];

  for (const { projection, refresh, values } of projections) {
    const started = deferred<void>();
    const pending = deferred<Array<{ id: string }>>();
    activeRead = { projection, calls: 0, started, pending };
    const staleRefresh = refresh(current!);
    await started.promise;

    await act(async () => {
      root.render(createElement(Probe, { revision: ++renderRevision }));
    });
    await act(async () => {
      await refresh(current!);
    });
    assert.deepEqual(values(current!).map(({ id }) => id), [`${projection}-new`]);

    await act(async () => {
      pending.resolve([{ id: `${projection}-old` }]);
      await staleRefresh;
    });
    assert.deepEqual(values(current!).map(({ id }) => id), [`${projection}-new`]);
    assert.equal(activeRead.calls, 2);

    const errorStarted = deferred<void>();
    const pendingError = deferred<Array<{ id: string }>>();
    activeRead = {
      projection,
      calls: 0,
      started: errorStarted,
      pending: pendingError,
    };
    const staleErrorRefresh = refresh(current!);
    await errorStarted.promise;
    await act(async () => {
      await refresh(current!);
    });
    await act(async () => {
      pendingError.reject(new Error(`${projection} stale failure`));
      await staleErrorRefresh;
    });
    assert.deepEqual(errors, []);
    assert.equal(activeRead.calls, 2);
  }
});

afterEach(() => {
  cleanupFakeDom();
});

async function importModuleData(): Promise<typeof ModuleData> {
  const outdir = await mkdtemp(resolve(REPO_ROOT, 'apps/desktop/dist/main/__tests__/module-data-'));
  const outfile = resolve(outdir, 'use-module-data.mjs');
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [resolve(REPO_ROOT, 'apps/desktop/src/renderer/use-module-data.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['react'],
    logLevel: 'silent',
  });
  return (await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)) as typeof ModuleData;
}
