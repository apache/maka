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
  cloneElement,
  createContext,
  useContext,
  useLayoutEffect,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { ScheduledTask } from '@maka/core/scheduled-task';
import {
  useModuleHubController,
  type ModuleHubCommands,
  type ModuleHubHostModel,
  type UseModuleHubControllerInput,
} from '../controller/use-module-hub-controller.js';

const ModuleHubHostContext = createContext<ModuleHubHostModel | null>(null);
const ModuleHubScheduledTasksContext = createContext<
  readonly ScheduledTask[] | null
>(null);
const ModuleHubSkillCatalogRevisionContext = createContext<number | null>(null);

export interface ModuleHubCommandPort extends ModuleHubCommands {
  connect(target: ModuleHubCommands): () => void;
}

export interface ModuleHubProviderProps extends UseModuleHubControllerInput {
  readonly commandPort: ModuleHubCommandPort;
  readonly children?: ReactNode;
}

export function createModuleHubCommandPort(): ModuleHubCommandPort {
  let target: ModuleHubCommands | null = null;
  return {
    connect(next) {
      target = next;
      return () => {
        if (target === next) target = null;
      };
    },
    refreshProjectSkills: () =>
      target?.refreshProjectSkills() ?? Promise.resolve(),
    openScheduledTaskCreate: () => target?.openScheduledTaskCreate(),
    copyTodayDailyReview: () =>
      target?.copyTodayDailyReview() ?? Promise.resolve(),
    pasteTodayDailyReview: () =>
      target?.pasteTodayDailyReview() ?? Promise.resolve(),
    saveTodayDailyReview: () =>
      target?.saveTodayDailyReview() ?? Promise.resolve(),
  };
}

/**
 * Owns the Module Hub controller below AppShell.
 *
 * Module Hub updates re-render this provider and the three narrow readers
 * below it. `children` is the element AppShell already built, so React can
 * bail out of the rest of the frame instead of widening feature state back to
 * the shell root.
 */
export function ModuleHubProvider({
  commandPort,
  children,
  ...input
}: ModuleHubProviderProps) {
  const controller = useModuleHubController(input);

  useLayoutEffect(
    () => commandPort.connect(controller.commands),
    [commandPort, controller.commands],
  );

  return (
    <ModuleHubHostContext.Provider value={controller.host}>
      <ModuleHubScheduledTasksContext.Provider
        value={controller.selectors.scheduledTasks}
      >
        <ModuleHubSkillCatalogRevisionContext.Provider
          value={controller.selectors.skillCatalogRevision}
        >
          {children}
        </ModuleHubSkillCatalogRevisionContext.Provider>
      </ModuleHubScheduledTasksContext.Provider>
    </ModuleHubHostContext.Provider>
  );
}

export function useModuleHubHostModel(): ModuleHubHostModel {
  const model = useContext(ModuleHubHostContext);
  if (!model) throw new Error('ModuleHubProvider is missing');
  return model;
}

interface ScheduledTasksTargetProps {
  readonly scheduledTasks?: readonly ScheduledTask[];
}

/** Injects the rail's read-only Scheduled Tasks projection at its reader. */
export function ModuleHubScheduledTasksBoundary(props: {
  readonly children: ReactElement<ScheduledTasksTargetProps>;
}) {
  const scheduledTasks = useContext(ModuleHubScheduledTasksContext);
  if (!scheduledTasks) throw new Error('ModuleHubProvider is missing');
  return cloneElement(props.children, { scheduledTasks });
}

interface SkillCatalogRevisionTargetProps {
  readonly skillCatalogRevision?: number;
}

/** Injects the catalog revision into Composer mentions without waking AppShell. */
export function ModuleHubSkillCatalogRevisionBoundary(props: {
  readonly children: ReactElement<SkillCatalogRevisionTargetProps>;
}) {
  const skillCatalogRevision = useContext(
    ModuleHubSkillCatalogRevisionContext,
  );
  if (skillCatalogRevision === null) {
    throw new Error('ModuleHubProvider is missing');
  }
  return cloneElement(props.children, { skillCatalogRevision });
}

export type { ModuleHubCommands } from '../controller/use-module-hub-controller.js';
