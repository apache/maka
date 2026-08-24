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

function catalog(host: TaskEntryHost = readyHost()): TaskEntryCatalog {
  return { defaultProfileId: 'local', hosts: [host] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

let latestController: TaskEntryController | undefined;

function ControllerProbe(props: { reportError(error: unknown): void }) {
  latestController = useTaskEntryController({ reportError: props.reportError });
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
) {
  root.render(
    createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(
        TaskEntryServicesProvider,
        { services },
        createElement(ControllerProbe, {
          reportError: (error: unknown) => errors.push(error),
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
  it('projects the canonical target, draft identity, Host defaults, and Workspace Picker', async () => {
    const { root } = installReactRenderer();
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => catalog(),
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
  });

  it('commits only the latest catalog refresh and releases its subscription', async () => {
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
    await act(async () => second.resolve(catalog(readyHost({ hostId: 'new-generation' }))));
    assert.equal(controller().selectors.target?.hostId, 'new-generation');

    await act(async () => first.resolve(catalog(readyHost({ hostId: 'stale-generation' }))));
    assert.equal(controller().selectors.target?.hostId, 'new-generation');

    await act(async () => root.unmount());
    assert.equal(disposed, 1);
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
      controller().selectors.workspacePicker.groups[0]?.onAdd?.();
      controller().selectors.workspacePicker.groups[0]?.onAdd?.();
    });
    assert.equal(addCalls, 1);
    assert.equal(controller().selectors.workspacePicker.pending, true);

    await act(async () => added.resolve({ ok: true, project: project('project-b') }));
    assert.equal(controller().selectors.target?.projectId, 'project-b');
    assert.equal(controller().selectors.workspacePicker.pending, false);
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
    const remoteHost = (hostId: string) => ({
      ...readyHost({ chooseClientDirectory: false, chooseHostDirectory: true }),
      profile: {
        id: 'remote',
        name: 'Remote',
        kind: 'remote' as const,
      },
      hostId,
    });
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => ({
          defaultProfileId: 'remote',
          hosts: [remoteHost(++reads === 1 ? 'generation-a' : 'generation-b')],
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

  it('opens a newly added remote Host from the committed catalog generation', async () => {
    const { root } = installReactRenderer();
    const stale = deferred<TaskEntryCatalog>();
    const current = deferred<TaskEntryCatalog>();
    let reads = 0;
    const remoteHost = (hostId: string) => ({
      ...readyHost({ chooseClientDirectory: false, chooseHostDirectory: true }),
      profile: {
        id: 'remote',
        name: 'Remote',
        kind: 'remote' as const,
      },
      hostId,
    });
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => {
          reads += 1;
          if (reads === 1) {
            return { defaultProfileId: 'remote', hosts: [remoteHost('initial')] };
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
    await act(async () => current.resolve({
      defaultProfileId: 'remote',
      hosts: [remoteHost('current-generation')],
    }));
    await act(async () => stale.resolve({
      defaultProfileId: 'remote',
      hosts: [remoteHost('stale-generation')],
    }));
    await act(async () => Promise.all([choose, refresh]));

    assert.equal(controller().selectors.target?.hostId, 'current-generation');
    assert.equal(controller().host.directoryHost?.hostId, 'current-generation');
  });
});
