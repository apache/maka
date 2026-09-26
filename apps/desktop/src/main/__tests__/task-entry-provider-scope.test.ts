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
import { act, createElement, Fragment, type ReactNode } from 'react';
import { LocaleProvider, ToastProvider, type WorkspacePickerModel } from '@maka/ui';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import type { ProjectedLlmConnection } from '@maka/core/llm-connections';
import { deferred } from '@maka/core/test-only/async-primitives';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import {
  createFakeTaskEntryServices,
  TaskEntryRoot,
  TaskEntryServicesProvider,
  TaskEntryWorkspacePickerConsumer,
  useTaskEntryHostModel,
  type TaskEntryCatalog,
  type TaskEntryHost,
  type TaskEntryShellProjection,
  type TaskEntryServices,
} from '../../renderer/features/task-entry/testing.js';
import { useShellChatModel } from '../../renderer/features/conversation/testing.js';
import { ConversationServicesProvider, type ConversationServices } from '../../renderer/features/conversation/index.js';

const thinkingServices = {
  subscribeChanges: () => () => undefined,
  newTasks: { subscribeChanges: () => () => undefined },
  sessions: {},
} as unknown as ConversationServices;

let shellRenders = 0;
let frameRenders = 0;
let workspaceRenders = 0;
let hostRenders = 0;
let latestTaskEntry: TaskEntryShellProjection | undefined;
let latestDirectoryHostId: string | undefined;
let latestProjectDialog: ReturnType<typeof useTaskEntryHostModel>['newProjectDialog'];
let latestWorkspaceGroupCount = 0;
let latestChatModel: ReturnType<typeof useShellChatModel> | undefined;
let thinkingActiveId: string | undefined;
let thinkingChoices: ChatModelChoice[];
const CONNECTION: ProjectedLlmConnection = { connectionId: 'c', slug: 'c', providerType: 'openai', name: 'C', enabled: true, defaultModel: 'm', enabledModelIds: ['m'], createdAt: 1, updatedAt: 1, catalogEntries: [] };
const CHOICE: ChatModelChoice = { connectionId: 'c', connectionSlug: 'c', connectionName: 'C', providerType: 'openai', providerLabel: 'C', model: 'm', label: 'M', isDefault: true, thinkingLevels: ['high'] };
let latestRecoveryPicker: WorkspacePickerModel | undefined;
let recoverySelectedProject: string | undefined;
let recoveryPickerOpenStates: boolean[] = [];

function project(id: string) {
  return {
    id,
    name: id,
    locations: [{ path: `/tmp/${id}`, isWorktree: false }],
    available: true,
    preferredPath: `/tmp/${id}`,
  };
}

function remoteHost(): Extract<TaskEntryHost, { state: 'available' }> {
  return {
    profile: { id: 'remote', name: 'Remote', kind: 'remote' },
    hostId: 'host-remote',
    readiness: 'ready',
    state: 'available',
    projects: [project('project-a')],
    capabilities: {
      chooseClientDirectory: false,
      chooseHostDirectory: true,
      selectNoProject: false,
    },
    selectedProjectId: 'project-a',
    chatDefaults: { permissionMode: 'ask', thinkingLevel: 'high' },
  };
}

function localHost(projects: ReturnType<typeof project>[] = []): Extract<TaskEntryHost, { state: 'available' }> {
  return {
    profile: { id: 'local', name: 'Local', kind: 'local' },
    hostId: 'host-local',
    readiness: 'ready',
    state: 'available',
    projects,
    capabilities: {
      chooseClientDirectory: true,
      chooseHostDirectory: false,
      selectNoProject: true,
    },
    selectedProjectId: projects[0]?.id,
    chatDefaults: { permissionMode: 'ask', thinkingLevel: 'high' },
  };
}

function catalog(): TaskEntryCatalog {
  return { defaultProfileId: 'remote', hosts: [remoteHost()] };
}

function localCatalog(projects: ReturnType<typeof project>[] = []): TaskEntryCatalog {
  return { defaultProfileId: 'local', hosts: [localHost(projects)] };
}

function WorkspaceProbe() {
  return createElement(TaskEntryWorkspacePickerConsumer, {
    manageProjects() {},
    children: (workspacePicker) => {
      workspaceRenders += 1;
      latestWorkspaceGroupCount = workspacePicker.groups.length;
      return null;
    },
  });
}

function HostProbe() {
  const host = useTaskEntryHostModel();
  hostRenders += 1;
  latestDirectoryHostId = host.directoryHost?.hostId;
  latestProjectDialog = host.newProjectDialog;
  return null;
}

function RecoveryWorkspaceProbe({ local = false }: { local?: boolean }) {
  return createElement(TaskEntryWorkspacePickerConsumer, {
    manageProjects() {},
    activeSession: local
      ? {
          id: 'session-1',
          profileId: 'local',
          runtimeHostId: 'host-local',
          projectId: null,
          profileKind: 'local',
        }
      : {
          id: 'session-1',
          profileId: 'remote',
          runtimeHostId: 'host-remote',
          projectId: 'missing-project',
          profileKind: 'remote',
        },
    children: (workspacePicker) => {
      latestRecoveryPicker = workspacePicker;
      if (workspacePicker.showForActiveSession) {
        recoveryPickerOpenStates.push(workspacePicker.isMenuOpen === true);
      }
      return null;
    },
  });
}

function FrameProbe() {
  frameRenders += 1;
  return createElement(Fragment, null, createElement(WorkspaceProbe), createElement(HostProbe));
}

function ShellProbe() {
  return createElement(TaskEntryRoot, {
    children: (taskEntry) => {
      shellRenders += 1;
      latestTaskEntry = taskEntry;
      return createElement(FrameProbe);
    },
  });
}
function ThinkingProbe({ taskEntry }: { taskEntry: TaskEntryShellProjection }) {
  latestChatModel = useShellChatModel({ uiLocale: 'en', connections: [CONNECTION], chatModelChoices: thinkingChoices ?? [CHOICE], sessionSendOutcome: undefined, defaultConnection: 'c', newTaskKey: taskEntry.selectors.draftKey, activeId: thinkingActiveId, activeSession: undefined, sessionHealthSession: undefined, persistedComposerDefaults: null, usePersistedComposerDefaults: false, connectionSnapshotReady: true, modelPickerDisabled: false, openSettingsSection() {}, openModelPicker() {}, refreshModelChoices: async () => undefined });
  return null;
}
function ThinkingShellProbe() {
  return createElement(TaskEntryRoot, { children: (taskEntry) => {
    latestTaskEntry = taskEntry;
    return createElement(ConversationServicesProvider, { services: thinkingServices, children: createElement(ThinkingProbe, { taskEntry }) });
  } });
}

function RecoveryShellProbe() {
  return createElement(TaskEntryRoot, {
    children: (taskEntry) => {
      latestTaskEntry = taskEntry;
      return createElement(RecoveryWorkspaceProbe);
    },
  });
}

function LocalRecoveryShellProbe() {
  return createElement(TaskEntryRoot, {
    children: (taskEntry) => {
      latestTaskEntry = taskEntry;
      return createElement(RecoveryWorkspaceProbe, { local: true });
    },
  });
}

function renderProvider(
  root: ReturnType<typeof installReactRenderer>['root'],
  services: TaskEntryServices,
  probe: ReactNode = createElement(ShellProbe),
) {
  root.render(
    createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(
        ToastProvider,
        null,
        createElement(
          TaskEntryServicesProvider,
          { services },
          probe,
        ),
      ),
    }),
  );
}

afterEach(() => {
  shellRenders = 0;
  frameRenders = 0;
  workspaceRenders = 0;
  hostRenders = 0;
  latestTaskEntry = undefined;
  latestDirectoryHostId = undefined;
  latestProjectDialog = undefined;
  latestWorkspaceGroupCount = 0;
  latestChatModel = undefined;
  thinkingActiveId = undefined;
  thinkingChoices = [CHOICE];
  latestRecoveryPicker = undefined;
  recoverySelectedProject = undefined;
  recoveryPickerOpenStates = [];
  cleanupFakeDom();
});

describe('TaskEntryRoot render scope', () => {
  it('keeps thinking across a same-Host add after the refreshed catalog contains the Project', async () => {
    const { root } = installReactRenderer();
    const refreshed = deferred<TaskEntryCatalog>();
    let reads = 0;
    const host = { ...remoteHost(), capabilities: { chooseClientDirectory: true, chooseHostDirectory: false, selectNoProject: false } };
    const services = createFakeTaskEntryServices({ catalog: {
      ...createFakeTaskEntryServices().catalog,
      getCatalog: async () => ++reads === 1 ? { defaultProfileId: 'remote', hosts: [host] } : refreshed.promise,
      addProject: async () => ({ ok: true, project: project('project-b') }),
    } });
    await act(async () => renderProvider(root, services, createElement(ThinkingShellProbe)));
    await act(async () => latestChatModel?.setPendingNewChatThinkingLevel('high'));
    await act(async () => latestTaskEntry?.commands.addProject());
    assert.equal(latestChatModel?.pendingNewChatThinkingLevel, 'high');
    await act(async () => refreshed.resolve({ defaultProfileId: 'remote', hosts: [{ ...host, projects: [project('project-a'), project('project-b')] }] }));
    assert.match(latestTaskEntry?.selectors.draftKey ?? '', /project-b/);
    assert.equal(latestChatModel?.pendingNewChatThinkingLevel, 'high');
  });

  it('keeps a non-default native model and thinking when adding a project on a non-default Host', async () => {
    const { root } = installReactRenderer();
    thinkingChoices = [CHOICE, { ...CHOICE, model: 'other', label: 'Other', isDefault: false }];
    const host = { ...remoteHost(), capabilities: { chooseClientDirectory: true, chooseHostDirectory: false, selectNoProject: false } };
    let added = false;
    const services = createFakeTaskEntryServices({ catalog: {
      ...createFakeTaskEntryServices().catalog,
      getCatalog: async () => ({ defaultProfileId: 'local', hosts: [localHost([project('local-project')]), { ...host, projects: added ? [project('project-a'), project('project-b')] : host.projects }] }),
      addProject: async () => { added = true; return { ok: true, project: project('project-b') }; },
    } });
    await act(async () => renderProvider(root, services, createElement(ThinkingShellProbe)));
    await act(async () => latestTaskEntry?.commands.selectProject(latestTaskEntry.selectors.projectScopes.find((scope) => scope.project.id === 'project-a')!.key));
    await act(async () => latestChatModel?.setPendingNewChatModel({ llmConnectionId: 'c', llmConnectionSlug: 'c', model: 'other' }));
    await act(async () => latestChatModel?.setPendingNewChatThinkingLevel('high'));
    assert.equal(latestChatModel?.newChatModel?.model, 'other');
    await act(async () => latestTaskEntry?.commands.addProject());
    assert.match(latestTaskEntry?.selectors.draftKey ?? '', /project-b/);
    assert.equal(latestChatModel?.newChatModel?.model, 'other');
    assert.equal(latestChatModel?.pendingNewChatThinkingLevel, 'high');
    // Navigating back preserves the source; ordinary navigation to a third
    // project must not reuse the consumed handoff.
    await act(async () => latestTaskEntry?.commands.selectProject(latestTaskEntry.selectors.projectScopes.find((scope) => scope.project.id === 'project-a')!.key));
    assert.equal(latestChatModel?.newChatModel?.model, 'other');
    assert.equal(latestChatModel?.pendingNewChatThinkingLevel, 'high');
    await act(async () => latestTaskEntry?.commands.selectLocalProject('local-project'));
    assert.equal(latestChatModel?.newChatModel?.model, 'm');
    assert.equal(latestChatModel?.pendingNewChatThinkingLevel, undefined);
  });

  for (const destination of ['existing-choice', 'model-removed'] as const) {
    it(`does not overwrite destination choices or restore an unavailable model: ${destination}`, async () => {
      const { root } = installReactRenderer();
      thinkingChoices = [CHOICE, { ...CHOICE, model: 'other', label: 'Other', isDefault: false }];
      const host = { ...remoteHost(), projects: [project('project-a'), project('project-b')], capabilities: { chooseClientDirectory: true, chooseHostDirectory: false, selectNoProject: false } };
      const services = createFakeTaskEntryServices({ catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => ({ defaultProfileId: 'remote', hosts: [host] }),
        addProject: async () => {
          if (destination === 'model-removed') thinkingChoices = [CHOICE];
          return { ok: true, project: project('project-b') };
        },
      } });
      await act(async () => renderProvider(root, services, createElement(ThinkingShellProbe)));
      const select = async (id: string) => act(async () => {
        latestTaskEntry?.commands.selectProject(latestTaskEntry.selectors.projectScopes.find((scope) => scope.project.id === id)!.key);
      });
      if (destination === 'existing-choice') {
        await select('project-b');
        await act(async () => latestChatModel?.setPendingNewChatModel(null));
        await act(async () => latestChatModel?.setPendingNewChatThinkingLevel(null));
        await select('project-a');
      }
      await act(async () => latestChatModel?.setPendingNewChatModel({ llmConnectionId: 'c', llmConnectionSlug: 'c', model: 'other' }));
      await act(async () => latestChatModel?.setPendingNewChatThinkingLevel('high'));
      await act(async () => latestTaskEntry?.commands.addProject());
      assert.match(latestTaskEntry?.selectors.draftKey ?? '', /project-b/);
      assert.equal(latestChatModel?.newChatModel?.model, 'm');
      assert.equal(latestChatModel?.pendingNewChatThinkingLevel, destination === 'existing-choice' ? null : undefined);
    });
  }

  it('does not hand off thinking while an active session id has no loaded session', async () => {
    const { root } = installReactRenderer();
    const refreshed = deferred<TaskEntryCatalog>();
    let reads = 0;
    thinkingActiveId = 'loading-session';
    const host = { ...remoteHost(), capabilities: { chooseClientDirectory: true, chooseHostDirectory: false, selectNoProject: false } };
    const services = createFakeTaskEntryServices({ catalog: {
      ...createFakeTaskEntryServices().catalog,
      getCatalog: async () => ++reads === 1 ? { defaultProfileId: 'remote', hosts: [host] } : refreshed.promise,
      addProject: async () => ({ ok: true, project: project('project-b') }),
    } });
    await act(async () => renderProvider(root, services, createElement(ThinkingShellProbe)));
    await act(async () => latestChatModel?.setPendingNewChatThinkingLevel('high'));
    await act(async () => latestTaskEntry?.commands.addProject());
    await act(async () => refreshed.resolve({ defaultProfileId: 'remote', hosts: [{ ...host, projects: [project('project-a'), project('project-b')] }] }));
    assert.match(latestTaskEntry?.selectors.draftKey ?? '', /project-b/);
    assert.equal(latestChatModel?.pendingNewChatThinkingLevel, undefined);
  });
  it('keeps a controller-only directory handoff below the shell frame', async () => {
    const { root } = installReactRenderer();
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => catalog(),
      },
    });

    await act(async () => renderProvider(root, services));
    assert.equal(latestTaskEntry?.selectors.target?.hostId, 'host-remote');
    assert.equal(latestWorkspaceGroupCount, 1);

    const shellBefore = shellRenders;
    const frameBefore = frameRenders;
    const workspaceBefore = workspaceRenders;
    const hostBefore = hostRenders;
    await act(async () => latestTaskEntry?.commands.addProject());

    assert.equal(latestDirectoryHostId, 'host-remote');
    assert.equal(shellRenders, shellBefore);
    assert.equal(frameRenders, frameBefore);
    assert.equal(workspaceRenders, workspaceBefore);
    assert.equal(hostRenders, hostBefore + 1);

    await act(async () => root.unmount());
  });

  it('opens and closes the named-project dialog without rerendering the shell', async () => {
    const { root } = installReactRenderer();
    const names: Array<string | undefined> = [];
    const host = {
      ...remoteHost(),
      capabilities: { chooseClientDirectory: true, chooseHostDirectory: false, selectNoProject: false },
    };
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => ({ defaultProfileId: 'remote', hosts: [host] }),
        addProject: async (_host, name) => {
          names.push(name);
          return { ok: false, reason: 'cancelled' };
        },
      },
    });
    await act(async () => renderProvider(root, services));
    const before = { shell: shellRenders, frame: frameRenders, workspace: workspaceRenders };
    await act(async () => latestTaskEntry?.commands.openNewProject());
    assert.ok(latestProjectDialog);
    assert.deepEqual({ shell: shellRenders, frame: frameRenders, workspace: workspaceRenders }, before);
    await act(async () => latestProjectDialog?.submit('Named from the rail'));
    assert.deepEqual(names, ['Named from the rail']);
    await act(async () => latestProjectDialog?.close());
    assert.equal(latestProjectDialog, undefined);
    await act(async () => latestTaskEntry?.commands.addProject('Named through the bridge'));
    assert.deepEqual(names, ['Named from the rail', 'Named through the bridge']);
    await act(async () => root.unmount());
  });

  it('retains the shell projection across an equivalent catalog refresh', async () => {
    const { root } = installReactRenderer();
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => catalog(),
      },
    });

    await act(async () => renderProvider(root, services));
    const shellBefore = shellRenders;
    const frameBefore = frameRenders;
    await act(async () => latestTaskEntry?.commands.refresh());

    assert.equal(shellRenders, shellBefore);
    assert.equal(frameRenders, frameBefore);
    assert.equal(latestTaskEntry?.selectors.target?.projectId, 'project-a');

    await act(async () => root.unmount());
  });

  it('scopes active-session recovery to available projects on that Host', async () => {
    const { root } = installReactRenderer();
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => catalog(),
      },
      sessions: {
        relocateWorkspace: async (_sessionId, projectId) => {
          recoverySelectedProject = projectId;
          return { ok: true };
        },
      },
    });

    await act(async () => {
      root.render(
        createElement(LocaleProvider, {
          locale: 'en',
          children: createElement(
            ToastProvider,
            null,
            createElement(
              TaskEntryServicesProvider,
              { services },
              createElement(RecoveryShellProbe),
            ),
          ),
        }),
      );
    });

    await act(async () => {
      latestTaskEntry?.commands.openSessionWorkspaceRecovery('session-1');
    });

    assert.equal(latestRecoveryPicker?.showForActiveSession, true);
    assert.equal(latestRecoveryPicker?.isMenuOpen, true);
    assert.deepEqual(recoveryPickerOpenStates.slice(-2), [false, true]);
    assert.equal(latestRecoveryPicker?.groups.length, 1);
    assert.deepEqual(
      latestRecoveryPicker?.groups[0]?.projects.map(({ id }) => id),
      ['project-a'],
    );
    await act(async () => latestRecoveryPicker?.onOpenChange?.(false));
    assert.equal(latestRecoveryPicker?.isMenuOpen, false);
    assert.equal(latestRecoveryPicker?.showForActiveSession, true);
    // The readiness action is repeatable after dismissing its menu.
    await act(async () => latestTaskEntry?.commands.openSessionWorkspaceRecovery('session-1'));
    assert.equal(latestRecoveryPicker?.isMenuOpen, true);
    await act(async () => {
      latestRecoveryPicker?.groups[0]?.onSelectProject?.('project-a');
      await Promise.resolve();
    });
    assert.equal(recoverySelectedProject, 'project-a');
    assert.equal(latestRecoveryPicker?.showForActiveSession, undefined);

    await act(async () => root.unmount());
  });

  it('adds a local Project before relocating the active Session', async () => {
    const { root } = installReactRenderer();
    const calls: string[] = [];
    let reads = 0;
    const services = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => {
          reads += 1;
          return reads === 1 ? localCatalog() : localCatalog([project('project-new')]);
        },
        addProject: async (host, name) => {
          calls.push(`add:${host.profileId}:${host.hostId}:${name}`);
          return { ok: true, project: project('project-new') };
        },
      },
      sessions: {
        relocateWorkspace: async (sessionId, projectId) => {
          calls.push(`relocate:${sessionId}:${projectId}`);
          return { ok: true };
        },
      },
    });

    await act(async () => renderProvider(root, services, createElement(LocalRecoveryShellProbe)));
    await act(async () => latestTaskEntry?.commands.openSessionWorkspaceRecovery('session-1'));
    assert.equal(typeof latestRecoveryPicker?.groups[0]?.onAdd, 'function');

    // DropdownMenu closes when New project is selected, before the naming
    // dialog submits. Its owning picker and Session context must survive.
    await act(async () => latestRecoveryPicker?.onOpenChange?.(false));
    assert.equal(latestRecoveryPicker?.showForActiveSession, true);
    assert.equal(latestRecoveryPicker?.isMenuOpen, false);
    await act(async () => {
      latestRecoveryPicker?.groups[0]?.onAdd?.('Imported');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.deepEqual(calls, ['add:local:host-local:Imported', 'relocate:session-1:project-new']);
    assert.equal(latestRecoveryPicker?.showForActiveSession, undefined);
    await act(async () => root.unmount());
  });
});
