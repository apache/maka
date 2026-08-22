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

import { useRef, useState } from 'react';
import type { ScheduledTask } from '@maka/core/scheduled-task';
import type { UiLocale } from '@maka/core/ui-locale';
import type { BundledSkillCatalogEntry, ManagedSkillSourceEntry, SkillEntry } from '@maka/ui';
import {
  createAppShellScheduledTaskActions,
  type AppShellScheduledTaskActions,
} from './app-shell-scheduled-task-actions';
import { createAppShellSkillActions, type AppShellSkillActions } from './app-shell-skill-actions';

type ToastApi = {
  success(title: string, description?: string): void;
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { profileId: string },
  ): void;
  confirm(options: {
    title: string;
    description: string;
    confirmLabel: string;
    cancelLabel: string;
    destructive?: boolean;
  }): Promise<boolean>;
};

/**
 * Owns the two sidebar-module data clusters — installed/managed/bundled
 * skills and scheduled tasks — together with their refresh + mutation
 * helpers. The
 * surface-active predicates are injected so the mutation helpers only
 * surface error toasts while their module is the foreground view, exactly
 * as before. Pure move: every returned action keeps its prior identity
 * semantics (recreated each render alongside the shell) and the task
 * getter reads the latest values on each call.
 */
export function useAppShellModuleData(options: {
  uiLocale: UiLocale;
  isSkillsSurfaceActive: () => boolean;
  isScheduledTasksSurfaceActive: () => boolean;
  toastApi: ToastApi;
}): AppShellScheduledTaskActions & AppShellSkillActions & {
  skills: SkillEntry[];
  managedSkillSources: ManagedSkillSourceEntry[];
  bundledSkillCatalog: BundledSkillCatalogEntry[];
  scheduledTasks: ScheduledTask[];
} {
  const {
    uiLocale,
    isSkillsSurfaceActive,
    isScheduledTasksSurfaceActive,
    toastApi,
  } = options;
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [managedSkillSources, setManagedSkillSources] = useState<ManagedSkillSourceEntry[]>([]);
  const [bundledSkillCatalog, setBundledSkillCatalog] = useState<BundledSkillCatalogEntry[]>([]);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
  const refreshGenerationsRef = useRef({
    skills: 0,
    managedSkillSources: 0,
    bundledSkillCatalog: 0,
    scheduledTasks: 0,
  });

  const scheduledTaskActions = createAppShellScheduledTaskActions({
    uiLocale,
    getScheduledTasks: () => scheduledTasks,
    isScheduledTasksSurfaceActive,
    refreshGenerationsRef,
    setScheduledTasks,
    toastApi,
  });

  const skillActions = createAppShellSkillActions({
    uiLocale,
    isSkillsSurfaceActive,
    refreshGenerationsRef,
    setSkills,
    setManagedSkillSources,
    setBundledSkillCatalog,
    toastApi,
  });

  return {
    skills,
    managedSkillSources,
    bundledSkillCatalog,
    scheduledTasks,
    ...scheduledTaskActions,
    ...skillActions,
  };
}
