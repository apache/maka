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

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useToast, type WorkspacePickerModel } from '@maka/ui';
import {
  useTaskEntryController,
  type TaskEntryController,
  type TaskEntryControllerCommands,
  type TaskEntryControllerSelectors,
} from '../controller/use-task-entry-controller.js';
import { taskEntryDraftKey } from '../model/task-entry-selection.js';
import type { TaskEntryError } from '../ports.js';
import type { TaskEntryHostModel } from './task-entry-host.js';

type Listener = () => void;

interface TaskEntryOwner {
  getState(): TaskEntryController;
  subscribe(listener: Listener): () => void;
  readonly commands: TaskEntryControllerCommands;
}

export interface TaskEntryShellProjection {
  readonly commands: TaskEntryControllerCommands;
  readonly selectors: Omit<TaskEntryControllerSelectors, 'workspacePicker'>;
}

interface TaskEntryProviderProps {
  readonly owner: TaskEntryOwner;
  readonly children?: ReactNode;
}

export interface TaskEntryRootProps {
  readonly children: (taskEntry: TaskEntryShellProjection) => ReactNode;
}

const EMPTY_WORKSPACE_PICKER: WorkspacePickerModel = {
  pending: true,
  groups: [],
};

const EMPTY_CONTROLLER: TaskEntryController = {
  host: {
    closeDirectoryPicker() {},
    async acceptRegisteredProject() {},
  },
  commands: {
    async refresh() {},
    selectLocalProject: () => false,
    addProject() {},
    async chooseProjectForProfile() {},
  },
  selectors: {
    draftKey: taskEntryDraftKey(undefined),
    defaultProfileId: 'local',
    usesDefaultHost: true,
    workspacePicker: EMPTY_WORKSPACE_PICKER,
    canAddProject: false,
  },
};

const TaskEntryOwnerContext = createContext<TaskEntryOwner | null>(null);

function ignoreManageProjects(): void {}

function createTaskEntryOwner(): TaskEntryOwner & {
  publish(controller: TaskEntryController): void;
} {
  let current = EMPTY_CONTROLLER;
  const listeners = new Set<Listener>();
  const owner = {
    getState: () => current,
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    commands: {
      refresh: () => current.commands.refresh(),
      selectLocalProject: (projectId: string) =>
        current.commands.selectLocalProject(projectId),
      addProject: () => current.commands.addProject(),
      chooseProjectForProfile: (profileId: string) =>
        current.commands.chooseProjectForProfile(profileId),
    },
    publish(controller: TaskEntryController): void {
      if (current === controller) return;
      current = controller;
      for (const listener of [...listeners]) listener();
    },
  };
  return owner;
}

function useTaskEntrySelection<T>(
  owner: TaskEntryOwner,
  select: (controller: TaskEntryController) => T,
  isEqual: (previous: T, next: T) => boolean = Object.is,
): T {
  const getSnapshot = useMemo(() => {
    let cachedController: TaskEntryController | undefined;
    let cachedSelection: T | undefined;
    return (): T => {
      const controller = owner.getState();
      if (controller === cachedController) return cachedSelection as T;
      const next = select(controller);
      if (cachedController === undefined || !isEqual(cachedSelection as T, next)) {
        cachedSelection = next;
      }
      cachedController = controller;
      return cachedSelection as T;
    };
  }, [isEqual, owner, select]);
  return useSyncExternalStore(owner.subscribe, getSnapshot, getSnapshot);
}

function sameTarget(
  previous: TaskEntryControllerSelectors['target'],
  next: TaskEntryControllerSelectors['target'],
): boolean {
  return previous === next || Boolean(
    previous &&
      next &&
      previous.profileId === next.profileId &&
      previous.hostId === next.hostId &&
      previous.projectId === next.projectId,
  );
}

function sameSelectedHost(
  previous: TaskEntryControllerSelectors['selectedHost'],
  next: TaskEntryControllerSelectors['selectedHost'],
): boolean {
  return previous === next || Boolean(
    previous &&
      next &&
      previous.profileId === next.profileId &&
      previous.hostId === next.hostId &&
      previous.name === next.name &&
      previous.kind === next.kind &&
      previous.chatDefaults.permissionMode === next.chatDefaults.permissionMode &&
      previous.chatDefaults.thinkingLevel === next.chatDefaults.thinkingLevel,
  );
}

const selectShellSelectors = (
  controller: TaskEntryController,
): Omit<TaskEntryControllerSelectors, 'workspacePicker'> => {
  const { workspacePicker: _workspacePicker, ...selectors } = controller.selectors;
  return selectors;
};

function sameShellSelectors(
  previous: Omit<TaskEntryControllerSelectors, 'workspacePicker'>,
  next: Omit<TaskEntryControllerSelectors, 'workspacePicker'>,
): boolean {
  return (
    sameTarget(previous.target, next.target) &&
    previous.draftKey === next.draftKey &&
    previous.projectPath === next.projectPath &&
    sameSelectedHost(previous.selectedHost, next.selectedHost) &&
    previous.selectedProfileId === next.selectedProfileId &&
    previous.defaultProfileId === next.defaultProfileId &&
    previous.usesDefaultHost === next.usesDefaultHost &&
    previous.canAddProject === next.canAddProject
  );
}

const selectWorkspacePicker = (controller: TaskEntryController): WorkspacePickerModel =>
  controller.selectors.workspacePicker;
const selectHost = (controller: TaskEntryController): TaskEntryHostModel => controller.host;

function sameHost(previous: TaskEntryHostModel, next: TaskEntryHostModel): boolean {
  return (
    previous.directoryHost?.profileId === next.directoryHost?.profileId &&
    previous.directoryHost?.hostId === next.directoryHost?.hostId &&
    previous.directoryHost?.name === next.directoryHost?.name &&
    previous.directoryOpener === next.directoryOpener &&
    previous.closeDirectoryPicker === next.closeDirectoryPicker &&
    previous.acceptRegisteredProject === next.acceptRegisteredProject
  );
}

/**
 * Creates the stable bridge AppShell reads without owning the Task Entry controller.
 * Controller-only updates keep the same shell projection identity and therefore
 * stop at the provider or the matching leaf reader.
 */
function useTaskEntryOwnership(): TaskEntryShellProjection & { readonly owner: TaskEntryOwner } {
  const owner = useMemo(createTaskEntryOwner, []);
  const selectors = useTaskEntrySelection(owner, selectShellSelectors, sameShellSelectors);
  return useMemo(
    () => ({ owner, commands: owner.commands, selectors }),
    [owner, selectors],
  );
}

/** Owns Task Entry catalog/selection lifecycle below AppShell. */
export function TaskEntryProvider({
  owner: ownerInput,
  children,
}: TaskEntryProviderProps) {
  const owner = ownerInput as ReturnType<typeof createTaskEntryOwner>;
  const toastApi = useToast();
  const reportError = useCallback(
    ({ title, description, profileId }: TaskEntryError) => {
      toastApi.error(title, description, undefined, { profileId });
    },
    [toastApi],
  );
  const controller = useTaskEntryController({ reportError, manageProjects: ignoreManageProjects });
  useLayoutEffect(() => owner.publish(controller), [controller, owner]);

  return (
    <TaskEntryOwnerContext.Provider value={owner}>
      {children}
    </TaskEntryOwnerContext.Provider>
  );
}

/** Mounts the controller owner and hands only its stable shell projection outward. */
export function TaskEntryRoot({ children }: TaskEntryRootProps) {
  const ownership = useTaskEntryOwnership();
  const taskEntry = useMemo<TaskEntryShellProjection>(
    () => ({ commands: ownership.commands, selectors: ownership.selectors }),
    [ownership.commands, ownership.selectors],
  );
  return (
    <TaskEntryProvider owner={ownership.owner}>
      {children(taskEntry)}
    </TaskEntryProvider>
  );
}

function useTaskEntryOwner(): TaskEntryOwner {
  const owner = useContext(TaskEntryOwnerContext);
  if (!owner) throw new Error('TaskEntryProvider is missing');
  return owner;
}

export function TaskEntryWorkspacePickerConsumer({
  manageProjects,
  children,
}: {
  readonly manageProjects: (profileId: string) => void;
  readonly children: (workspacePicker: WorkspacePickerModel) => ReactNode;
}) {
  const owner = useTaskEntryOwner();
  const controllerPicker = useTaskEntrySelection(owner, selectWorkspacePicker);
  const workspacePicker = useMemo<WorkspacePickerModel>(
    () => ({
      ...controllerPicker,
      groups: controllerPicker.groups.map((group) =>
        group.onManage
          ? { ...group, onManage: () => manageProjects(group.id) }
          : group),
    }),
    [controllerPicker, manageProjects],
  );
  return children(workspacePicker);
}

export function useTaskEntryHostModel(): TaskEntryHostModel {
  return useTaskEntrySelection(useTaskEntryOwner(), selectHost, sameHost);
}
