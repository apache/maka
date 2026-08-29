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

import { useEffect, useMemo, useRef } from 'react';
import type { ScheduledTask, ScheduledTaskEffect } from '@maka/core/scheduled-task';
import type { NavSelection } from '@maka/ui';
import { useToast, useUiLocale } from '@maka/ui';
import { useModuleHubServices } from '../services-context.js';
import { startModuleHubLifecycle } from './module-hub-lifecycle.js';
import {
  useKeepSystemAwakeController,
  type KeepSystemAwakeController,
} from './use-keep-system-awake-controller.js';
import {
  useScheduledTasksController,
  type ScheduledTasksController,
} from './use-scheduled-tasks-controller.js';
import {
  useSkillsController,
  type SkillsHostModel,
} from './use-skills-controller.js';

export interface ModuleHubHostModel {
  readonly selection: NavSelection;
  readonly selectModule: (selection: NavSelection) => void;
  readonly skills: SkillsHostModel;
  readonly scheduledTasks: ScheduledTasksController;
  readonly keepSystemAwake: KeepSystemAwakeController;
  readonly agentRunTemplateEffect?: Extract<ScheduledTaskEffect, { kind: 'agent_run' }>;
}

export interface ModuleHubController {
  readonly host: ModuleHubHostModel;
  readonly commands: {
    refreshProjectSkills(): Promise<void>;
    openScheduledTaskCreate(): void;
  };
  readonly selectors: {
    readonly scheduledTasks: readonly ScheduledTask[];
    /** Invalidates the composer's Runtime-owned invocable Skills projection. */
    readonly skillCatalogRevision: number;
  };
}

export interface UseModuleHubControllerInput {
  readonly selection: NavSelection;
  readonly selectModule: (selection: NavSelection) => void;
  readonly openSkillsFolder?: () => void | Promise<void>;
  readonly useSkillInChat: (skillId: string, skillName: string) => void;
  readonly agentRunTemplateEffect?: Extract<ScheduledTaskEffect, { kind: 'agent_run' }>;
}

/** Public ownership boundary for every Module Hub surface except the MCP leaf. */
export function useModuleHubController(
  input: UseModuleHubControllerInput,
): ModuleHubController {
  const services = useModuleHubServices();
  const uiLocale = useUiLocale();
  const toastApi = useToast();
  const isSkillsActive =
    input.selection.section === 'extensions' &&
    input.selection.module === 'skills';
  const skills = useSkillsController({
    uiLocale,
    active: isSkillsActive,
    toastApi,
    useSkillInChat: input.useSkillInChat,
    openSkillsFolder: input.openSkillsFolder,
  });
  const scheduledTasks = useScheduledTasksController({
    uiLocale,
    toastApi,
    selection: input.selection,
    selectModule: input.selectModule,
  });
  const keepSystemAwake = useKeepSystemAwakeController(services);
  const refreshProjectSkillsRef = useRef(skills.refreshProjectSkills);
  const refreshScheduledTasksRef = useRef(scheduledTasks.refresh);
  refreshProjectSkillsRef.current = skills.refreshProjectSkills;
  refreshScheduledTasksRef.current = scheduledTasks.refresh;

  useEffect(() => {
    return startModuleHubLifecycle({
      runtimeHosts: services.runtimeHosts,
      refreshProjectSkills: () => void refreshProjectSkillsRef.current(),
      refreshScheduledTasks: () => void refreshScheduledTasksRef.current(),
    });
  }, [services.runtimeHosts]);

  return useMemo(
    () => ({
      host: {
        selection: input.selection,
        selectModule: input.selectModule,
        skills: skills.host,
        scheduledTasks,
        keepSystemAwake,
        agentRunTemplateEffect: input.agentRunTemplateEffect,
      },
      commands: {
        refreshProjectSkills: skills.refreshProjectSkills,
        openScheduledTaskCreate: scheduledTasks.openCreate,
      },
      selectors: {
        scheduledTasks: scheduledTasks.scheduledTasks,
        skillCatalogRevision: skills.revision,
      },
    }),
    [
      input.selectModule,
      input.selection,
      input.agentRunTemplateEffect,
      keepSystemAwake,
      scheduledTasks,
      skills.host,
      skills.refreshProjectSkills,
      skills.revision,
    ],
  );
}
