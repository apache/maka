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
  useContext,
  useLayoutEffect,
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

/**
 * The stable command surface AppShell holds while the controller below it is
 * replaced.
 *
 * `connect` runs from a layout effect keyed on `controller.commands`, and that
 * object is rebuilt whenever the controller's `useMemo` input changes — which
 * includes `openSession`, a fresh arrow on every AppShell render. So the effect
 * re-runs on every shell render: cleanup, then connect. The identity check in
 * the cleanup is what keeps that churn harmless — a stale cleanup must never
 * detach a newer target that connected after it.
 */
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

/**
 * Hands the rail's read-only Scheduled Tasks projection to its reader.
 *
 * `render` receives the projection together with the element AppShell already
 * built, so the reader's prop stays required and typed at the call site, and a
 * Scheduled Tasks change re-renders only this boundary and the element
 * `render` returns — the children it forwards keep their identity.
 */
export function ModuleHubScheduledTasksBoundary(props: {
  readonly render: (
    scheduledTasks: readonly ScheduledTask[],
    children: ReactNode,
  ) => ReactNode;
  readonly children?: ReactNode;
}): ReactNode {
  const scheduledTasks = useContext(ModuleHubScheduledTasksContext);
  if (!scheduledTasks) throw new Error('ModuleHubProvider is missing');
  return props.render(scheduledTasks, props.children);
}

/** Hands the Skill catalog revision to Composer mentions without waking AppShell. */
export function ModuleHubSkillCatalogRevisionBoundary(props: {
  readonly render: (
    skillCatalogRevision: number,
    children: ReactNode,
  ) => ReactNode;
  readonly children?: ReactNode;
}): ReactNode {
  const skillCatalogRevision = useContext(
    ModuleHubSkillCatalogRevisionContext,
  );
  if (skillCatalogRevision === null) {
    throw new Error('ModuleHubProvider is missing');
  }
  return props.render(skillCatalogRevision, props.children);
}

export type { ModuleHubCommands } from '../controller/use-module-hub-controller.js';
