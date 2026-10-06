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

import { deferred } from '@maka/core/test-only/async-primitives';
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { act, createElement } from 'react';
import { LocaleProvider, ToastProvider } from '@maka/ui';
import { getShellCopy } from '../../renderer/locales/shell-copy.js';
import {
  createDesktopTaskEntryServices,
  type DesktopTaskEntryBridge,
} from '../../renderer/platform/desktop/create-task-entry-services.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import {
  createFakeTaskEntryServices,
  TaskEntryServicesProvider,
  useTaskEntryController,
  type TaskEntryCatalog,
  type TaskEntryController,
  type TaskEntryFolderOpenResult,
  type TaskEntryHost,
  type TaskEntryServices,
} from '../../renderer/features/task-entry/testing.js';

function project(id: string) {
  return {
    id,
    name: id,
    locations: [{ path: `/tmp/${id}`, isWorktree: false }],
    available: true,
    preferredPath: `/tmp/${id}`,
  };
}

function readyHost(input: {
  hostId?: string;
  projects?: ReturnType<typeof project>[];
  selectedProjectId?: string | null;
  chooseClientDirectory?: boolean;
  chooseHostDirectory?: boolean;
  selectNoProject?: boolean;
} = {}): Extract<TaskEntryHost, { state: 'available' }> {
  return {
    profile: { id: 'local', name: 'Local', kind: 'local' },
    hostId: input.hostId ?? 'host-local',
    readiness: 'ready',
    state: 'available',
    projects: input.projects ?? [project('project-a')],
    capabilities: {
      chooseClientDirectory: input.chooseClientDirectory ?? true,
      chooseHostDirectory: input.chooseHostDirectory ?? false,
      selectNoProject: input.selectNoProject ?? false,
    },
    selectedProjectId: input.selectedProjectId ?? 'project-a',
    chatDefaults: { permissionMode: 'ask', thinkingLevel: 'high' },
    branch: 'main',
  };
}

function readyRemoteHost(hostId: string): Extract<TaskEntryHost, { state: 'available' }> {
  return {
    ...readyHost({ chooseClientDirectory: false, chooseHostDirectory: true }),
    profile: {
      id: 'remote',
      name: 'Remote',
      kind: 'remote',
    },
    hostId,
  };
}

function reconnectingRemoteHost(): TaskEntryHost {
  return {
    profile: {
      id: 'remote',
      name: 'Remote',
      kind: 'remote',
    },
    readiness: 'reconnecting',
    message: 'Reconnecting',
  };
}

function catalog(host: TaskEntryHost = readyHost()): TaskEntryCatalog {
  return { defaultProfileId: 'local', hosts: [host] };
}
let latestController: TaskEntryController | undefined;

function ControllerProbe(props: {
  reportError(error: unknown): void;
  confirm?(input: { title: string; onConfirm?(): Promise<void> }): Promise<boolean>;
}) {
  latestController = useTaskEntryController({
    reportError: props.reportError,
    manageProjects() {},
    ...(props.confirm ? { confirm: props.confirm } : {}),
  });
  return null;
}

function controller(): TaskEntryController {
  assert.ok(latestController);
  return latestController;
}

function renderController(
  root: ReturnType<typeof installReactRenderer>['root'],
  services: TaskEntryServices,
  errors: unknown[] = [],
  confirm?: (input: { title: string }) => Promise<boolean>,
  locale: 'en' | 'zh-CN' | 'zh-TW' = 'en',
) {
  root.render(
    createElement(LocaleProvider, {
      locale,
      children: createElement(
        ToastProvider,
        null,
        createElement(
        TaskEntryServicesProvider,
        { services },
        createElement(ControllerProbe, {
          reportError: (error: unknown) => errors.push(error),
          confirm: confirm ? async (input) => {
            const accepted = await confirm(input);
            if (accepted) await input.onConfirm?.();
            return accepted;
          } : undefined,
        }),
      ),
      ),
    }),
  );
}

async function sessionRecoveryHarness(options: {
  add?: TaskEntryServices['catalog']['addProject'];
  restore?: TaskEntryServices['catalog']['restoreProject'];
  relocate?: TaskEntryServices['sessions']['relocateWorkspace'];
  getCatalog?: TaskEntryServices['catalog']['getCatalog'];
  confirm?: (input: { title: string; description?: string; confirmLabel?: string }) => Promise<boolean>;
} = {}) {
  const { root } = installReactRenderer();
  const calls: string[] = [];
  const errors: unknown[] = [];
  let restoredProject: ReturnType<typeof project> | undefined;
  const services = createFakeTaskEntryServices({
    catalog: {
      ...createFakeTaskEntryServices().catalog,
      getCatalog: async () => {
        calls.push('catalog');
        return options.getCatalog ? options.getCatalog() : catalog(readyHost({
          projects: [project('project-a'), ...(restoredProject ? [restoredProject] : [])],
        }));
      },
      addProject: async (host, name) => {
        calls.push(`add:${host.profileId}:${host.hostId}:${name}`);
        return options.add ? options.add(host, name) : { ok: false, reason: 'archived', projectId: 'project-b' };
      },
      restoreProject: async (host, id) => {
        calls.push(`restore:${host.profileId}:${host.hostId}:${id}`);
        const result = options.restore ? await options.restore(host, id) : { ok: true as const, project: project(id) };
        if (result.ok) restoredProject = { ...project(result.project.id), ...result.project };
        return result;
      },
      archiveProject: async () => { assert.fail('Recovery must never roll back by archiving'); },
      renameProject: async () => { assert.fail('Restoring must preserve the original name'); },
    },
    sessions: {
      relocateWorkspace: async (sessionId, projectId) => {
        calls.push(`relocate:${sessionId}:${projectId}`);
        return options.relocate ? options.relocate(sessionId, projectId) : { ok: true };
      },
    },
  });
  const confirm = async (input: { title: string; description?: string; confirmLabel?: string }) => {
    calls.push('confirm');
    return options.confirm ? options.confirm(input) : true;
  };
  await act(async () => renderController(root, services, errors, confirm));
  await act(async () => controller().commands.openSessionWorkspaceRecovery('session-1'));
  const request = controller().selectors.sessionWorkspaceRecovery!;
  const add = () => controller().commands.addSessionWorkspace({
    sessionId: 'session-1',
    profileId: 'local',
    host: { profileId: 'local', hostId: 'host-local' },
    name: 'Do not rename restored project',
    request,
  });
  return { root, calls, errors, services, request, add, confirm };
}

afterEach(() => {
  latestController = undefined;
  cleanupFakeDom();
});

describe('Session workspace archived-project recovery', () => {
  it('confirms use for this Session, restores original identity, then relocates without selecting a new-task Project', async () => {
    const harness = await sessionRecoveryHarness({
      confirm: async (input) => {
        assert.equal(input.confirmLabel, 'Restore and use for this session');
        assert.match(input.description ?? '', /this session’s workspace/);
        return true;
      },
    });
    const initialTarget = controller().selectors.target;
    await act(async () => assert.equal(await harness.add(), true));
    assert.deepEqual(harness.calls, [
      'catalog', 'add:local:host-local:Do not rename restored project', 'confirm',
      'restore:local:host-local:project-b', 'relocate:session-1:project-b', 'catalog',
    ]);
    assert.deepEqual(controller().selectors.target, initialTarget);
    assert.ok(controller().selectors.workspacePicker.groups[0]?.projects.some((project) => project.id === 'project-b'));
    assert.equal(controller().selectors.sessionWorkspaceRecovery, undefined);
    assert.equal(controller().selectors.workspacePicker.pending, false);
    assert.deepEqual(harness.errors, []);
  });

  for (const stage of ['directory', 'confirmation', 'restoration'] as const) {
    it(`cancels at ${stage} without relocation, refresh, or an error`, async () => {
      const harness = await sessionRecoveryHarness({
        ...(stage === 'directory' ? { add: async () => ({ ok: false as const, reason: 'cancelled' as const }) } : {}),
        ...(stage === 'confirmation' ? { confirm: async () => false } : {}),
        ...(stage === 'restoration' ? { restore: async () => ({ ok: false as const, reason: 'cancelled' as const }) } : {}),
      });
      await act(async () => assert.equal(await harness.add(), false));
      assert.equal(harness.calls.some((call) => call.startsWith('relocate')), false);
      assert.equal(harness.calls.filter((call) => call === 'catalog').length, 1);
      assert.equal(harness.calls.filter((call) => call.startsWith('restore')).length, stage === 'restoration' ? 1 : 0);
      assert.equal(controller().selectors.sessionWorkspaceRecovery, harness.request);
      assert.equal(controller().selectors.workspacePicker.pending, false);
      assert.deepEqual(harness.errors, []);
    });
  }

  it('retains the restored Project and recovery intent when relocation fails', async () => {
    const harness = await sessionRecoveryHarness({ relocate: async () => ({ ok: false, reason: 'session_busy' }) });
    await act(async () => assert.equal(await harness.add(), false));
    assert.equal(controller().selectors.sessionWorkspaceRecovery, harness.request);
    assert.equal(controller().selectors.workspacePicker.pending, false);
    assert.equal(harness.errors.length, 1);
    assert.match(JSON.stringify(harness.errors), /project was restored and has not been archived again/);
    assert.equal(harness.calls.at(-1), 'catalog');
    // Retry uses the normal existing-Project path; it does not restore again.
    await act(async () => controller().commands.relocateSessionWorkspace({
      sessionId: 'session-1', profileId: 'local', projectId: 'project-b', request: harness.request,
    }));
    assert.equal(harness.calls.filter((call) => call.startsWith('restore')).length, 1);
    assert.equal(harness.calls.filter((call) => call.startsWith('relocate')).length, 2);
  });

  it('rejects an unavailable restored directory without losing the partial success', async () => {
    const harness = await sessionRecoveryHarness({
      restore: async () => ({ ok: true, project: { ...project('project-b'), available: false } }),
    });
    await act(async () => assert.equal(await harness.add(), false));
    assert.equal(harness.calls.some((call) => call.startsWith('relocate')), false);
    assert.match(JSON.stringify(harness.errors), /project was restored.*directory is unavailable/);
    assert.equal(controller().selectors.sessionWorkspaceRecovery, harness.request);
  });

  it('does not claim an IPC restore rejection is a definite failure or retry it automatically', async () => {
    const fail = async (): Promise<never> => { throw new Error('commit_outcome_unknown'); };
    const harness = await sessionRecoveryHarness({ restore: fail });
    await act(async () => assert.equal(await harness.add(), false));
    assert.match(JSON.stringify(harness.errors), /Could not confirm/);
    assert.match(JSON.stringify(harness.errors), /before deciding to retry/);
    assert.equal(harness.calls.filter((call) => call.startsWith('restore')).length, 1);
    assert.equal(harness.calls.some((call) => call.startsWith('relocate')), false);
    assert.equal(controller().selectors.sessionWorkspaceRecovery, harness.request);
    assert.equal(controller().selectors.workspacePicker.pending, false);
  });

  it('reports a restore that still returns archived instead of silently stopping', async () => {
    const harness = await sessionRecoveryHarness({ restore: async () => ({ ok: false, reason: 'archived', projectId: 'project-b' }) });
    await act(async () => assert.equal(await harness.add(), false));
    assert.equal(harness.calls.some((call) => call.startsWith('relocate')), false);
    assert.equal(harness.errors.length, 1);
    assert.equal(controller().selectors.workspacePicker.pending, false);
  });

  it('keeps relocation successful when the subsequent catalog refresh fails', async () => {
    let reads = 0;
    const harness = await sessionRecoveryHarness({
      getCatalog: async () => {
        if (++reads > 1) throw new Error('offline');
        return catalog();
      },
    });
    await act(async () => assert.equal(await harness.add(), true));
    assert.equal(controller().selectors.sessionWorkspaceRecovery, undefined);
    assert.equal(controller().selectors.workspacePicker.pending, false);
    assert.equal(harness.errors.length, 1);
    assert.match(JSON.stringify(harness.errors), /Could not refresh projects/);
    assert.doesNotMatch(JSON.stringify(harness.errors), /Could not move|Could not confirm/);
  });

  it('keeps one physical mutation in flight through confirmation, restore, and relocation', async () => {
    const confirmed = deferred<boolean>();
    const restored = deferred<Awaited<ReturnType<TaskEntryServices['catalog']['restoreProject']>>>();
    const relocated = deferred<Awaited<ReturnType<TaskEntryServices['sessions']['relocateWorkspace']>>>();
    const harness = await sessionRecoveryHarness({
      confirm: () => confirmed.promise,
      restore: () => restored.promise,
      relocate: () => relocated.promise,
    });
    let running: Promise<boolean> | undefined;
    await act(async () => {
      running = harness.add();
      assert.equal(await harness.add(), false);
    });
    for (const advance of [
      () => confirmed.resolve(true),
      () => restored.resolve({ ok: true, project: project('project-b') }),
    ]) {
      assert.equal(controller().selectors.workspacePicker.pending, true);
      await act(async () => {
        assert.equal(await harness.add(), false);
        assert.equal(await controller().commands.relocateSessionWorkspace({
          sessionId: 'session-1', profileId: 'local', projectId: 'project-a',
        }), false);
        advance();
      });
    }
    await act(async () => {
      assert.equal(await harness.add(), false);
      relocated.resolve({ ok: true });
      assert.equal(await running, true);
    });
    assert.equal(harness.calls.filter((call) => call.startsWith('add')).length, 1);
    assert.equal(harness.calls.filter((call) => call.startsWith('restore')).length, 1);
    assert.equal(harness.calls.filter((call) => call.startsWith('relocate')).length, 1);
  });

  for (const stage of ['confirm', 'relocate'] as const) {
    it(`does not continue an obsolete ${stage} or close a newer request for the same Session`, async () => {
      const gate = deferred<void>();
      const harness = await sessionRecoveryHarness({
        add: async () => {
          return { ok: false, reason: 'archived', projectId: 'project-b' };
        },
        confirm: async () => { if (stage === 'confirm') await gate.promise; return true; },
        restore: async () => {
          return { ok: true, project: project('project-b') };
        },
        relocate: async () => { if (stage === 'relocate') await gate.promise; return { ok: true }; },
      });
      let running: Promise<boolean> | undefined;
      await act(async () => { running = harness.add(); });
      await act(async () => controller().commands.openSessionWorkspaceRecovery('session-1'));
      const newerRequest = controller().selectors.sessionWorkspaceRecovery;
      assert.notEqual(newerRequest, harness.request);
      await act(async () => {
        assert.equal(await harness.add(), false);
        gate.resolve();
        assert.equal(await running, false);
      });
      assert.equal(controller().selectors.sessionWorkspaceRecovery, newerRequest);
      assert.equal(harness.calls.filter((call) => call.startsWith('relocate')).length, stage === 'relocate' ? 1 : 0);
      if (stage === 'confirm') assert.equal(harness.calls.some((call) => call.startsWith('restore')), false);
      assert.deepEqual(harness.errors, []);
    });
  }

  for (const invalidation of ['close', 'unmount', 'service', 'host'] as const) {
    it(`does not restore after ${invalidation} invalidates the confirmation`, async () => {
      const confirmation = deferred<boolean>();
      let nextCatalog = catalog();
      const harness = await sessionRecoveryHarness({ confirm: () => confirmation.promise, getCatalog: async () => nextCatalog });
      let running: Promise<boolean> | undefined;
      await act(async () => { running = harness.add(); });
      await act(async () => {
        if (invalidation === 'close') controller().commands.closeSessionWorkspaceRecovery();
        if (invalidation === 'unmount') harness.root.unmount();
        if (invalidation === 'service') renderController(harness.root, {
          ...harness.services, catalog: { ...harness.services.catalog },
        }, harness.errors, harness.confirm);
        if (invalidation === 'host') {
          nextCatalog = catalog(readyHost({ hostId: 'replacement' }));
          await controller().commands.refresh();
        }
      });
      if (invalidation === 'host') {
        nextCatalog = catalog();
        await act(async () => controller().commands.refresh());
      }
      await act(async () => { confirmation.resolve(true); assert.equal(await running, false); });
      assert.equal(harness.calls.some((call) => call.startsWith('restore') || call.startsWith('relocate')), false);
      assert.deepEqual(harness.errors, []);
    });
  }
});

describe('useTaskEntryController', () => {
  it('projects the target and keeps draft identity in sync with Workspace Picker selections', async () => {
    const { root } = installReactRenderer();
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => catalog(readyHost({ selectNoProject: true })),
      },
    });

    await act(async () => renderController(root, services));

    assert.deepEqual(controller().selectors.target, {
      profileId: 'local',
      hostId: 'host-local',
      projectId: 'project-a',
    });
    assert.equal(controller().selectors.projectPath, '/tmp/project-a');
    assert.equal(controller().selectors.selectedHost?.chatDefaults.thinkingLevel, 'high');
    assert.equal(controller().selectors.usesDefaultHost, true);
    assert.equal(controller().selectors.workspacePicker.label, 'project-a');
    assert.equal(controller().selectors.workspacePicker.branch, 'main');
    assert.equal(controller().selectors.workspacePicker.groups[0]?.selectedProjectId, 'project-a');
    assert.match(controller().selectors.draftKey, /host-local.*project-a/);
    const projectDraftKey = controller().selectors.draftKey;

    await act(async () => controller().selectors.workspacePicker.groups[0]!.onSelectNoProject!());
    assert.equal(controller().selectors.target?.projectId, null);
    assert.notEqual(controller().selectors.draftKey, projectDraftKey);
    assert.equal(controller().selectors.workspacePicker.groups[0]?.selectedProjectId, null);

    await act(async () => controller().selectors.workspacePicker.groups[0]!.onSelectProject!('project-a'));
    assert.equal(controller().selectors.target?.projectId, 'project-a');
    assert.equal(controller().selectors.draftKey, projectDraftKey);
    assert.equal(controller().selectors.workspacePicker.label, 'project-a');
  });

  it('keeps same-id Projects scoped to their owning Runtime Host', async () => {
    const { root } = installReactRenderer();
    const local = readyHost();
    const remote = readyRemoteHost('host-remote');
    const calls: Array<{ action: string; profileId: string; hostId: string }> =
      [];
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => ({
          defaultProfileId: 'local',
          hosts: [local, remote],
        }),
        renameProject: async (host) => {
          calls.push({ action: 'rename', ...host });
        },
        archiveProject: async (host) => {
          calls.push({ action: 'archive', ...host });
        },
        restoreProject: async (host) => {
          calls.push({ action: 'restore', ...host });
          return { ok: true, project: project('project-a') };
        },
      },
    });

    await act(async () => renderController(root, services));
    const remoteScope = controller().selectors.projectScopes.find(
      (scope) => scope.hostId === 'host-remote',
    );
    assert.ok(remoteScope);
    await act(async () => {
      assert.equal(controller().commands.selectProject(remoteScope.key), true);
    });
    assert.deepEqual(controller().selectors.target, {
      profileId: 'remote',
      hostId: 'host-remote',
      projectId: 'project-a',
    });

    await act(async () =>
      controller().commands.renameProject(remoteScope.key, 'Renamed'),
    );
    await act(async () =>
      controller().commands.archiveProject(remoteScope.key),
    );
    await act(async () =>
      controller().commands.restoreProject(remoteScope.key),
    );
    assert.deepEqual(calls, [
      { action: 'rename', profileId: 'remote', hostId: 'host-remote' },
      { action: 'archive', profileId: 'remote', hostId: 'host-remote' },
      { action: 'restore', profileId: 'remote', hostId: 'host-remote' },
    ]);
  });

  it('drains a queued catalog refresh and releases its subscription', async () => {
    const { root } = installReactRenderer();
    const first = deferred<TaskEntryCatalog>();
    const second = deferred<TaskEntryCatalog>();
    let reads = 0;
    let emit: (() => void) | undefined;
    let disposed = 0;
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: () => (++reads === 1 ? first.promise : second.promise),
        subscribeChanges: (handler) => {
          emit = handler;
          return () => {
            disposed += 1;
          };
        },
      },
    });

    await act(async () => renderController(root, services));
    await act(async () => emit?.());
    assert.equal(reads, 1);

    await act(async () => first.resolve(catalog(readyHost({ hostId: 'stale-generation' }))));
    assert.equal(reads, 2);
    assert.equal(controller().selectors.target, undefined);

    await act(async () => second.resolve(catalog(readyHost({ hostId: 'new-generation' }))));
    assert.equal(controller().selectors.target?.hostId, 'new-generation');

    await act(async () => root.unmount());
    assert.equal(disposed, 1);
  });

  it('ignores an obsolete catalog read after the service lifecycle changes', async () => {
    const { root } = installReactRenderer();
    const obsolete = deferred<TaskEntryCatalog>();
    const current = deferred<TaskEntryCatalog>();
    const obsoleteServices = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: () => obsolete.promise,
      },
    });
    const currentServices = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: () => current.promise,
      },
    });

    await act(async () => renderController(root, obsoleteServices));
    await act(async () => renderController(root, currentServices));
    await act(async () => obsolete.resolve(catalog(readyHost({ hostId: 'obsolete' }))));

    assert.equal(controller().selectors.target, undefined);
    assert.equal(controller().selectors.workspacePicker.pending, true);

    await act(async () => current.resolve(catalog(readyHost({ hostId: 'current' }))));
    assert.equal(controller().selectors.target?.hostId, 'current');
    assert.equal(controller().selectors.workspacePicker.pending, false);
  });

  it('deduplicates add requests and selects the returned Project before refreshing', async () => {
    const { root } = installReactRenderer();
    const added = deferred<{
      ok: true;
      project: ReturnType<typeof project>;
    }>();
    let addCalls = 0;
    let reads = 0;
    const initialHost = readyHost();
    const refreshedHost = readyHost({
      projects: [project('project-a'), project('project-b')],
      selectedProjectId: 'project-a',
    });
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => catalog(++reads === 1 ? initialHost : refreshedHost),
        addProject: () => {
          addCalls += 1;
          return added.promise;
        },
      },
    });

    await act(async () => renderController(root, services));
    await act(async () => {
      controller().selectors.workspacePicker.groups[0]?.onAdd?.('New project');
      controller().selectors.workspacePicker.groups[0]?.onAdd?.('New project');
    });
    assert.equal(addCalls, 1);
    assert.equal(controller().selectors.workspacePicker.pending, true);

    await act(async () => added.resolve({ ok: true, project: project('project-b') }));
    assert.equal(controller().selectors.target?.projectId, 'project-b');
    assert.equal(controller().selectors.workspacePicker.pending, false);
  });

  it('prompts to restore an archived Project and selects it through the Desktop adapter after confirmation', async () => {
    const { root } = installReactRenderer();
    let reads = 0;
    let restoreCalls = 0;
    const refreshedHost = readyHost({
      projects: [project('project-a'), project('project-b')],
      selectedProjectId: 'project-a',
    });
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () =>
          catalog(++reads === 1 ? readyHost() : refreshedHost),
        addProject: async () => ({
          ok: false as const,
          reason: 'archived' as const,
          projectId: 'project-b',
        }),
        restoreProject: async () => {
          restoreCalls += 1;
          return { ok: true as const, project: project('project-b') };
        },
      },
    });

    const errors: unknown[] = [];
    const desktopServices = createDesktopTaskEntryServices({
      newTasks: services.catalog,
      projects: {},
    } as unknown as DesktopTaskEntryBridge);
    await act(async () => renderController(root, desktopServices, errors, async () => true));
    assert.equal(controller().selectors.target?.projectId, 'project-a');
    await act(async () => {
      controller().commands.addProject();
      await Promise.resolve();
    });
    await act(async () => {});

    assert.equal(restoreCalls, 1);
    assert.deepEqual(errors, []);
    assert.equal(controller().selectors.workspacePicker.pending, false);
    assert.equal(controller().selectors.target?.projectId, 'project-b');
  });

  it('reports restore failure and releases the pending state so the user can retry', async () => {
    const { root } = installReactRenderer();
    const restoration = deferred<{ ok: true; project: ReturnType<typeof project> }>();
    const errors: unknown[] = [];
    let restoreCalls = 0;
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => catalog(),
        addProject: async () => ({
          ok: false,
          reason: 'archived',
          projectId: 'project-b',
        }),
        restoreProject: async () => {
          restoreCalls += 1;
          return restoreCalls === 1
            ? restoration.promise
            : { ok: false, reason: 'cancelled' };
        },
      },
    });

    await act(async () => renderController(root, services, errors, async () => true));
    await act(async () => controller().commands.addProject());
    assert.equal(controller().selectors.workspacePicker.pending, true);

    await act(async () => restoration.reject(new Error('restore failed')));

    assert.deepEqual(errors, [{
      title: 'Could not select working directory',
      description: 'The project path is temporarily unavailable. Try again later.',
      profileId: 'local',
    }]);
    assert.equal(controller().selectors.target?.projectId, 'project-a');
    assert.equal(controller().selectors.workspacePicker.pending, false);

    await act(async () => controller().commands.addProject());
    assert.equal(restoreCalls, 2);
    assert.equal(errors.length, 1);
  });

  it('deduplicates relink requests and selects the returned Project before refreshing', async () => {
    const { root } = installReactRenderer();
    const relinked = deferred<{
      ok: true;
      project: ReturnType<typeof project>;
    }>();
    const relinkCalls: Array<{
      host: { profileId: string; hostId: string };
      projectId: string;
    }> = [];
    let reads = 0;
    const initialHost = readyHost();
    const refreshedHost = readyHost({
      projects: [project('project-a'), project('project-b')],
      selectedProjectId: 'project-a',
    });
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => catalog(++reads === 1 ? initialHost : refreshedHost),
        relinkProject: (host, projectId) => {
          relinkCalls.push({ host, projectId });
          return relinked.promise;
        },
      },
    });

    await act(async () => renderController(root, services));
    await act(async () => {
      controller().selectors.workspacePicker.groups[0]?.onRelink?.('project-a');
      controller().selectors.workspacePicker.groups[0]?.onRelink?.('project-a');
    });
    assert.deepEqual(relinkCalls, [{
      host: { profileId: 'local', hostId: 'host-local' },
      projectId: 'project-a',
    }]);
    assert.equal(controller().selectors.workspacePicker.pending, true);

    await act(async () => relinked.resolve({ ok: true, project: project('project-b') }));
    assert.equal(controller().selectors.target?.projectId, 'project-b');
    assert.equal(controller().selectors.workspacePicker.pending, false);
  });

  it('fences remote directory registration by Host generation', async () => {
    const { root } = installReactRenderer();
    let reads = 0;
    const remote = {
      ...readyHost({ chooseClientDirectory: false, chooseHostDirectory: true }),
      profile: {
        id: 'remote',
        name: 'Remote',
        kind: 'remote' as const,
      },
      hostId: 'remote-generation',
    };
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => {
          reads += 1;
          return {
            defaultProfileId: 'remote',
            hosts: [remote],
          };
        },
      },
    });

    await act(async () => renderController(root, services));
    await act(async () => controller().commands.addProject());
    assert.equal(controller().host.directoryHost?.hostId, 'remote-generation');

    await act(async () => controller().host.acceptRegisteredProject(
      project('wrong'),
      { profileId: 'remote', hostId: 'old-generation' },
    ));
    assert.equal(controller().host.directoryHost?.hostId, 'remote-generation');

    await act(async () => controller().host.acceptRegisteredProject(
      project('project-b'),
      { profileId: 'remote', hostId: 'remote-generation' },
    ));
    assert.equal(controller().host.directoryHost, undefined);
    assert.equal(reads, 2);
  });

  it('closes a remote directory handoff when the Host generation changes', async () => {
    const { root } = installReactRenderer();
    let reads = 0;
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => ({
          defaultProfileId: 'remote',
          hosts: [readyRemoteHost(++reads === 1 ? 'generation-a' : 'generation-b')],
        }),
      },
    });

    await act(async () => renderController(root, services));
    await act(async () => controller().commands.addProject());
    assert.equal(controller().host.directoryHost?.hostId, 'generation-a');

    await act(async () => controller().commands.refresh());
    assert.equal(controller().selectors.target?.hostId, 'generation-b');
    assert.equal(controller().host.directoryHost, undefined);

    await act(async () => controller().host.acceptRegisteredProject(
      project('stale-project'),
      { profileId: 'remote', hostId: 'generation-a' },
    ));
    assert.equal(reads, 2);
  });

  it('keeps a remote directory handoff across reconnecting and closes it when the profile disappears', async () => {
    const { root } = installReactRenderer();
    const catalogs: TaskEntryCatalog[] = [
      { defaultProfileId: 'remote', hosts: [readyRemoteHost('generation-a')] },
      { defaultProfileId: 'remote', hosts: [reconnectingRemoteHost()] },
      { defaultProfileId: 'remote', hosts: [readyRemoteHost('generation-a')] },
      { defaultProfileId: 'local', hosts: [] },
    ];
    let reads = 0;
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => catalogs[reads++]!,
      },
    });

    await act(async () => renderController(root, services));
    await act(async () => controller().commands.addProject());
    assert.deepEqual(controller().host.directoryHost, {
      profileId: 'remote',
      hostId: 'generation-a',
      name: 'Remote',
    });

    await act(async () => controller().commands.refresh());
    assert.equal(controller().host.directoryHost?.hostId, 'generation-a');
    assert.equal(controller().selectors.target, undefined);

    await act(async () => controller().commands.refresh());
    assert.equal(controller().host.directoryHost?.hostId, 'generation-a');
    assert.equal(controller().selectors.target?.hostId, 'generation-a');

    await act(async () => controller().commands.refresh());
    assert.equal(controller().host.directoryHost, undefined);
  });

  it('opens a newly added remote Host from the committed catalog generation', async () => {
    const { root } = installReactRenderer();
    const stale = deferred<TaskEntryCatalog>();
    const current = deferred<TaskEntryCatalog>();
    let reads = 0;
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => {
          reads += 1;
          if (reads === 1) {
            return { defaultProfileId: 'remote', hosts: [readyRemoteHost('initial')] };
          }
          return reads === 2 ? stale.promise : current.promise;
        },
      },
    });

    await act(async () => renderController(root, services));
    let choose!: Promise<void>;
    let refresh!: Promise<void>;
    await act(async () => {
      choose = controller().commands.chooseProjectForProfile('remote');
      refresh = controller().commands.refresh();
    });
    await act(async () => stale.resolve({
      defaultProfileId: 'remote',
      hosts: [readyRemoteHost('stale-generation')],
    }));
    assert.equal(controller().host.directoryHost, undefined);

    await act(async () => current.resolve({
      defaultProfileId: 'remote',
      hosts: [readyRemoteHost('current-generation')],
    }));
    await act(async () => Promise.all([choose, refresh]));

    assert.equal(controller().selectors.target?.hostId, 'current-generation');
    assert.equal(controller().host.directoryHost?.hostId, 'current-generation');
  });

  it('awaits the winning refresh when an onboarding catalog read settles stale first', async () => {
    const { root } = installReactRenderer();
    const stale = deferred<TaskEntryCatalog>();
    const current = deferred<TaskEntryCatalog>();
    const errors: unknown[] = [];
    let reads = 0;
    let emit: (() => void) | undefined;
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => {
          reads += 1;
          if (reads === 1) return catalog();
          return reads === 2 ? stale.promise : current.promise;
        },
        subscribeChanges: (handler) => {
          emit = handler;
          return () => undefined;
        },
      },
    });

    await act(async () => renderController(root, services, errors));
    let settled = false;
    let chooseError: unknown;
    let choose!: Promise<void>;
    await act(async () => {
      choose = controller().commands.chooseProjectForProfile('remote')
        .catch((error: unknown) => {
          chooseError = error;
        })
        .finally(() => {
          settled = true;
        });
      emit?.();
    });

    await act(async () => stale.resolve({
      defaultProfileId: 'remote',
      hosts: [readyRemoteHost('stale-generation')],
    }));
    assert.equal(settled, false);
    assert.equal(errors.length, 0);

    await act(async () => current.resolve({
      defaultProfileId: 'remote',
      hosts: [readyRemoteHost('current-generation')],
    }));
    await act(async () => choose);

    assert.equal(chooseError, undefined);
    assert.equal(errors.length, 0);
    assert.equal(controller().selectors.target?.hostId, 'current-generation');
    assert.equal(controller().host.directoryHost?.hostId, 'current-generation');
  });

  it('awaits the winning refresh when an onboarding catalog read rejects stale first', async () => {
    const { root } = installReactRenderer();
    const stale = deferred<TaskEntryCatalog>();
    const current = deferred<TaskEntryCatalog>();
    const errors: unknown[] = [];
    let reads = 0;
    let emit: (() => void) | undefined;
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => {
          reads += 1;
          if (reads === 1) return catalog();
          return reads === 2 ? stale.promise : current.promise;
        },
        subscribeChanges: (handler) => {
          emit = handler;
          return () => undefined;
        },
      },
    });

    await act(async () => renderController(root, services, errors));
    let settled = false;
    let chooseError: unknown;
    let choose!: Promise<void>;
    await act(async () => {
      choose = controller().commands.chooseProjectForProfile('remote')
        .catch((error: unknown) => {
          chooseError = error;
        })
        .finally(() => {
          settled = true;
        });
      emit?.();
    });

    await act(async () => stale.reject(new Error('stale catalog failed')));
    assert.equal(settled, false);
    assert.equal(errors.length, 0);

    await act(async () => current.resolve({
      defaultProfileId: 'remote',
      hosts: [readyRemoteHost('current-generation')],
    }));
    await act(async () => choose);

    assert.equal(chooseError, undefined);
    assert.equal(errors.length, 0);
    assert.equal(controller().selectors.target?.hostId, 'current-generation');
    assert.equal(controller().host.directoryHost?.hostId, 'current-generation');
  });

  it('falls back to a successful handoff catalog when the queued refresh fails', async () => {
    const { root } = installReactRenderer();
    const successful = deferred<TaskEntryCatalog>();
    const failed = deferred<TaskEntryCatalog>();
    const errors: unknown[] = [];
    let reads = 0;
    let emit: (() => void) | undefined;
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => {
          reads += 1;
          if (reads === 1) return catalog();
          return reads === 2 ? successful.promise : failed.promise;
        },
        subscribeChanges: (handler) => {
          emit = handler;
          return () => undefined;
        },
      },
    });

    await act(async () => renderController(root, services, errors));
    let settled = false;
    let chooseError: unknown;
    let choose!: Promise<void>;
    await act(async () => {
      choose = controller().commands.chooseProjectForProfile('remote')
        .catch((error: unknown) => {
          chooseError = error;
        })
        .finally(() => {
          settled = true;
        });
      emit?.();
    });

    await act(async () => successful.resolve({
      defaultProfileId: 'remote',
      hosts: [readyRemoteHost('successful-generation')],
    }));
    assert.equal(settled, false);
    assert.equal(reads, 3);

    await act(async () => failed.reject(new Error('queued catalog failed')));
    await act(async () => choose);

    assert.equal(chooseError, undefined);
    assert.equal(errors.length, 0);
    assert.equal(controller().selectors.target?.hostId, 'successful-generation');
    assert.equal(controller().host.directoryHost?.hostId, 'successful-generation');
    assert.ok(controller().selectors.workspacePicker.retry);
  });

  it('reports catalog unavailable once when every handoff refresh fails', async () => {
    const { root } = installReactRenderer();
    const errors: unknown[] = [];
    let reads = 0;
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => {
          reads += 1;
          if (reads === 1) return catalog();
          throw new Error('catalog unavailable');
        },
      },
    });

    await act(async () => renderController(root, services, errors));
    await act(async () => controller().commands.chooseProjectForProfile('remote'));

    assert.deepEqual(errors, [{
      title: 'Runtime Hosts unavailable',
      description: 'Runtime Hosts unavailable',
      profileId: 'remote',
    }]);
    assert.equal(controller().host.directoryHost, undefined);
  });

  it('reports project update failure when an added Project cannot refresh', async () => {
    const { root } = installReactRenderer();
    const refreshed = deferred<TaskEntryCatalog>();
    const errors: unknown[] = [];
    let reads = 0;
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => {
          reads += 1;
          return reads === 1 ? catalog() : refreshed.promise;
        },
        addProject: async () => ({ ok: true, project: project('project-b') }),
      },
    });

    await act(async () => renderController(root, services, errors));
    await act(async () => {
      controller().selectors.workspacePicker.groups[0]?.onAdd?.('New project');
      await Promise.resolve();
    });
    assert.equal(controller().selectors.workspacePicker.pending, true);

    await act(async () => refreshed.reject(new Error('catalog refresh failed')));

    assert.equal(controller().selectors.workspacePicker.pending, false);
    assert.deepEqual(errors, [{
      title: 'Could not update project',
      description: 'The project could not be updated. Try again later.',
      profileId: 'local',
    }]);
  });

  it('explains that a running Session must settle before workspace recovery', async () => {
    const { root } = installReactRenderer();
    const errors: unknown[] = [];
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => catalog(),
      },
      sessions: {
        relocateWorkspace: async () => ({ ok: false, reason: 'session_busy' }),
      },
    });

    await act(async () => renderController(root, services, errors));
    await act(async () => {
      await controller().commands.relocateSessionWorkspace({
        sessionId: 'session-1',
        profileId: 'local',
        projectId: 'project-a',
      });
    });

    assert.deepEqual(errors, [{
      title: 'Could not move task',
      description: 'A task is running. Wait for it to finish before moving this one.',
      profileId: 'local',
    }]);
  });

  describe('folders', () => {
    const copy = getShellCopy('en');
    const projectTitle = copy.projectActions.openFailedTitle(copy.projectActions.openPathLabels.project);
    const workspaceTitle = copy.projectActions.openFailedTitle(copy.projectActions.openPathLabels.workspace);

    async function openFolders(
      results: { project?: TaskEntryFolderOpenResult; workspace?: TaskEntryFolderOpenResult },
      run: (commands: TaskEntryController['commands']) => Promise<void>,
    ) {
      const { root } = installReactRenderer();
      const errors: unknown[] = [];
      const requests: Array<string | undefined> = [];
      const services = createFakeTaskEntryServices({
        folders: {
          openProjectFolder: async (sessionId) => {
            requests.push(sessionId);
            return results.project ?? { kind: 'opened' };
          },
          openWorkspaceFolder: async () => {
            requests.push('workspace');
            return results.workspace ?? { kind: 'opened' };
          },
        },
      });
      await act(async () => renderController(root, services, errors));
      await act(async () => run(controller().commands));
      return { errors, requests };
    }

    it('reports nothing when the folder opens', async () => {
      const { errors, requests } = await openFolders({}, async (commands) => {
        await commands.openProjectFolder('session-1');
        await commands.openProjectFolder();
        await commands.openWorkspaceFolder();
      });

      assert.deepEqual(requests, ['session-1', undefined, 'workspace']);
      assert.deepEqual(errors, []);
    });

    it('reports a refusal with its closed reason and the target the adapter named', async () => {
      const { errors } = await openFolders({
        project: { kind: 'refused', reason: 'missing', diagnosticTarget: { sessionId: 'session-1' } },
        workspace: { kind: 'refused', reason: 'raw-host-text', diagnosticTarget: { profileId: 'local' } },
      }, async (commands) => {
        await commands.openProjectFolder('session-1');
        await commands.openWorkspaceFolder();
      });

      assert.deepEqual(errors, [
        {
          title: projectTitle,
          description: copy.projectActions.openPathFailures.missing,
          sessionId: 'session-1',
        },
        {
          title: workspaceTitle,
          description: copy.projectActions.openPathFailures.unknown,
          profileId: 'local',
        },
      ]);
    });

    it('turns a vanished task workspace into the workspace-unavailable notice', async () => {
      const unavailable = Object.assign(new Error('gone'), { code: 'SESSION_WORKSPACE_UNAVAILABLE' });
      const { errors } = await openFolders({
        project: { kind: 'failed', error: unavailable, diagnosticTarget: { sessionId: 'session-1' } },
      }, async (commands) => {
        await commands.openProjectFolder('session-1');
      });

      assert.deepEqual(errors, [{
        title: copy.errors.workspaceUnavailableTitle,
        description: copy.errors.workspaceUnavailableDescription,
        sessionId: 'session-1',
      }]);
    });

    it('classifies other failures and keeps the Host authority, or none when it was never resolved', async (t) => {
      t.mock.method(console, 'error', () => undefined);
      const timeout = new Error('request timeout');
      const { errors } = await openFolders({
        project: { kind: 'failed', error: timeout },
        workspace: { kind: 'failed', error: timeout, diagnosticTarget: { profileId: 'local' } },
      }, async (commands) => {
        await commands.openProjectFolder();
        await commands.openWorkspaceFolder();
      });

      assert.deepEqual(errors, [
        { title: projectTitle, description: 'Request timed out' },
        { title: workspaceTitle, description: 'Request timed out', profileId: 'local' },
      ]);
    });
  });
});
