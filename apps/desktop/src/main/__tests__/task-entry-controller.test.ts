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
import { LocaleProvider } from '@maka/ui';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import {
  createFakeTaskEntryServices,
  TaskEntryServicesProvider,
  useTaskEntryController,
  type TaskEntryCatalog,
  type TaskEntryController,
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
  reportProjectAdded?(handoff: { fromKey: string; toKey: string }): void;
}) {
  latestController = useTaskEntryController({
    reportError: props.reportError,
    manageProjects() {},
    reportProjectAdded: props.reportProjectAdded,
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
  reportProjectAdded?: (handoff: { fromKey: string; toKey: string }) => void,
) {
  root.render(
    createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(
        TaskEntryServicesProvider,
        { services },
        createElement(ControllerProbe, {
          reportError: (error: unknown) => errors.push(error),
          reportProjectAdded,
        }),
      ),
    }),
  );
}

afterEach(() => {
  latestController = undefined;
  cleanupFakeDom();
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

  it('reports a draft handoff after adding a Project on the selected Host', async () => {
    const { root } = installReactRenderer();
    const handoffs: Array<{ fromKey: string; toKey: string }> = [];
    let reads = 0;
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => ++reads === 1
          ? catalog()
          : catalog(readyHost({ projects: [project('project-a'), project('project-b')] })),
        addProject: async () => ({ ok: true, project: project('project-b') }),
      },
    });

    await act(async () => renderController(root, services, [], (handoff) => handoffs.push(handoff)));
    const sourceKey = controller().selectors.draftKey;
    await act(async () => controller().commands.addProject());

    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0]?.fromKey, sourceKey);
    assert.match(handoffs[0]?.toKey ?? '', /project-b/);
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

  it('closes a successful registration after catalog recovery moves the source target', async () => {
    const { root } = installReactRenderer();
    const remote = readyRemoteHost('remote-generation');
    let snapshot: TaskEntryCatalog = { defaultProfileId: 'remote', hosts: [remote] };
    const renamed: string[] = [];
    const handoffs: unknown[] = [];
    const services = createFakeTaskEntryServices({ catalog: {
      ...createFakeTaskEntryServices().catalog,
      getCatalog: async () => snapshot,
      renameProject: async (_host, _id, name) => { renamed.push(name); },
    } });
    await act(async () => renderController(root, services, [], (handoff) => handoffs.push(handoff)));
    await act(async () => controller().commands.addProject('Named project'));
    snapshot = { defaultProfileId: 'remote', hosts: [{ ...remote, projects: [project('project-c')], selectedProjectId: 'project-c' }] };
    await act(async () => controller().commands.refresh());
    assert.equal(controller().selectors.target?.projectId, 'project-c');
    snapshot = { defaultProfileId: 'remote', hosts: [{ ...remote, projects: [project('project-c'), project('project-b')], selectedProjectId: 'project-c' }] };
    await act(async () => controller().host.acceptRegisteredProject(project('project-b'), { profileId: 'remote', hostId: 'remote-generation' }));
    assert.equal(controller().host.directoryHost, undefined);
    assert.deepEqual(renamed, ['Named project']);
    assert.equal(controller().selectors.target?.projectId, 'project-c');
    assert.equal(controller().selectors.projectScopes.some((scope) => scope.project.id === 'project-b'), true);
    assert.deepEqual(handoffs, []);
  });

  it('does not reclaim the profile when navigation happens during registration rename', async () => {
    const { root } = installReactRenderer();
    const renamed = deferred<void>();
    const remote = readyRemoteHost('remote-generation');
    const local = readyHost();
    let snapshot: TaskEntryCatalog = { defaultProfileId: 'remote', hosts: [remote, local] };
    const handoffs: unknown[] = [];
    const services = createFakeTaskEntryServices({ catalog: {
      ...createFakeTaskEntryServices().catalog,
      getCatalog: async () => snapshot,
      renameProject: async () => renamed.promise,
    } });
    await act(async () => renderController(root, services, [], (handoff) => handoffs.push(handoff)));
    await act(async () => controller().commands.addProject('Named project'));
    let registration!: Promise<void>;
    await act(async () => { registration = controller().host.acceptRegisteredProject(project('project-b'), { profileId: 'remote', hostId: 'remote-generation' }); });
    assert.equal(controller().host.directoryHost, undefined);
    await act(async () => { controller().commands.selectLocalProject('project-a'); });
    snapshot = { defaultProfileId: 'remote', hosts: [{ ...remote, projects: [project('project-a'), project('project-b')] }, local] };
    await act(async () => { renamed.resolve(); await registration; });
    assert.equal(controller().selectors.target?.profileId, 'local');
    assert.equal(controller().selectors.target?.projectId, 'project-a');
    assert.deepEqual(handoffs, []);
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
    const handoffs: Array<{ fromKey: string; toKey: string }> = [];
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

    await act(async () => renderController(root, services, errors, (handoff) => handoffs.push(handoff)));
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
    assert.deepEqual(handoffs, []);
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
});
