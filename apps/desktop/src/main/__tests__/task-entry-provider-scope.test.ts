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
import { act, createElement, Fragment } from 'react';
import { LocaleProvider, ToastProvider } from '@maka/ui';
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

let shellRenders = 0;
let frameRenders = 0;
let workspaceRenders = 0;
let hostRenders = 0;
let latestTaskEntry: TaskEntryShellProjection | undefined;
let latestDirectoryHostId: string | undefined;
let latestWorkspaceGroupCount = 0;

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

function catalog(): TaskEntryCatalog {
  return { defaultProfileId: 'remote', hosts: [remoteHost()] };
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
  return null;
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

function renderProvider(
  root: ReturnType<typeof installReactRenderer>['root'],
  services: TaskEntryServices,
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
          createElement(ShellProbe),
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
  latestWorkspaceGroupCount = 0;
  cleanupFakeDom();
});

describe('TaskEntryProvider render scope', () => {
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
});
