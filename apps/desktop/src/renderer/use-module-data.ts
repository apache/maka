import { useState } from 'react';
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
  error(title: string, description?: string): void;
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
  clearRuntimeHostModuleData(): void;
} {
  const { uiLocale, isSkillsSurfaceActive, isScheduledTasksSurfaceActive, toastApi } = options;
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [managedSkillSources, setManagedSkillSources] = useState<ManagedSkillSourceEntry[]>([]);
  const [bundledSkillCatalog, setBundledSkillCatalog] = useState<BundledSkillCatalogEntry[]>([]);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);

  const scheduledTaskActions = createAppShellScheduledTaskActions({
    uiLocale,
    getScheduledTasks: () => scheduledTasks,
    isScheduledTasksSurfaceActive,
    setScheduledTasks,
    toastApi,
  });

  const skillActions = createAppShellSkillActions({
    uiLocale,
    isSkillsSurfaceActive,
    setSkills,
    setManagedSkillSources,
    setBundledSkillCatalog,
    toastApi,
  });

  function clearRuntimeHostModuleData(): void {
    setSkills([]);
    setManagedSkillSources([]);
    setBundledSkillCatalog([]);
    setScheduledTasks([]);
  }

  return {
    skills,
    managedSkillSources,
    bundledSkillCatalog,
    scheduledTasks,
    clearRuntimeHostModuleData,
    ...scheduledTaskActions,
    ...skillActions,
  };
}
