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

import { useEffect, useRef, useState } from 'react';
import type {
  ScheduledTask,
  UpdateScheduledTaskInput,
} from '@maka/core/scheduled-task';
import type { UiLocale } from '@maka/core/ui-locale';
import type { NavSelection, ToastApi } from '@maka/ui';
import { useMountedRef } from '@maka/ui';
import { localizedShellErrorMessage } from '../../../locales/shell-copy.js';
import { getShellRemainingCopy } from '../../../locales/shell-remaining-copy.js';
import type { ScheduledTaskCreateInput } from '../ports.js';
import { useModuleHubServices } from '../services-context.js';
import {
  defaultRuntimeHostDiagnosticTarget,
  defaultRuntimeHostOperationHost,
  isDefaultRuntimeHostCurrent,
  runIfDefaultRuntimeHostCurrent,
  runOnDefaultRuntimeHost,
} from './default-runtime-host.js';

export interface ScheduledTasksController {
  readonly scheduledTasks: ScheduledTask[];
  readonly createRequestNonce: number;
  openCreate(): void;
  handleCreateRequest(): void;
  refresh(options?: { shouldShowError?: () => boolean }): Promise<void>;
  refreshSurface(): Promise<void>;
  create(input: ScheduledTaskCreateInput): Promise<boolean>;
  update(id: string, patch: UpdateScheduledTaskInput): Promise<boolean>;
  toggle(id: string, enabled: boolean): Promise<void>;
  triggerNow(id: string): Promise<void>;
  snooze(id: string): Promise<void>;
  clearRunHistory(id: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export type ScheduledTasksToastApi = Pick<
  ToastApi,
  'confirm' | 'error' | 'success' | 'toast'
>;

export function useScheduledTasksController(options: {
  uiLocale: UiLocale;
  toastApi: ScheduledTasksToastApi;
  selection: NavSelection;
  selectModule(selection: NavSelection): void;
}): ScheduledTasksController {
  const services = useModuleHubServices();
  const uiLocale = options.uiLocale;
  const toastApi = options.toastApi;
  const mountedRef = useMountedRef();
  const copy = getShellRemainingCopy(uiLocale).scheduledTaskActions;
  const notificationsCopy = getShellRemainingCopy(uiLocale).notifications;
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
  const [createRequestNonce, setCreateRequestNonce] = useState(0);
  const refreshGenerationRef = useRef(0);
  const scheduledTasksRef = useRef<readonly ScheduledTask[]>(scheduledTasks);
  const selectionRef = useRef(options.selection);
  const selectModuleRef = useRef(options.selectModule);
  const toastApiRef = useRef(toastApi);
  const notificationsCopyRef = useRef(notificationsCopy);
  const refreshRef = useRef<
    (options?: { shouldShowError?: () => boolean }) => Promise<void>
  >(async () => {});
  scheduledTasksRef.current = scheduledTasks;
  selectionRef.current = options.selection;
  selectModuleRef.current = options.selectModule;
  toastApiRef.current = toastApi;
  notificationsCopyRef.current = notificationsCopy;

  const isSurfaceActive = () =>
    mountedRef.current &&
    selectionRef.current.section === 'automations' &&
    selectionRef.current.module === 'scheduled-tasks';

  async function refresh(
    refreshOptions: { shouldShowError?: () => boolean } = {},
  ): Promise<void> {
    const generation = ++refreshGenerationRef.current;
    try {
      const next = await runOnDefaultRuntimeHost(
        services.runtimeHosts,
        (host) => services.scheduledTasks.list(host),
      );
      await runIfDefaultRuntimeHostCurrent(
        services.runtimeHosts,
        next.host,
        () => {
          if (
            mountedRef.current &&
            generation === refreshGenerationRef.current
          ) {
            setScheduledTasks(next.value);
          }
        },
      );
    } catch (error) {
      if (!mountedRef.current || generation !== refreshGenerationRef.current)
        return;
      const operationHost = defaultRuntimeHostOperationHost(error);
      const hostIsCurrent = operationHost
        ? await isDefaultRuntimeHostCurrent(
            services.runtimeHosts,
            operationHost,
          )
        : true;
      if (
        !mountedRef.current ||
        generation !== refreshGenerationRef.current ||
        !hostIsCurrent
      )
        return;
      if (refreshOptions.shouldShowError?.() ?? true) {
        toastApi.error(
          copy.refreshFailed,
          localizedShellErrorMessage(error, copy.refreshFallback, uiLocale),
          undefined,
          defaultRuntimeHostDiagnosticTarget(error),
        );
      }
    }
  }
  refreshRef.current = refresh;

  async function runMutation(mutation: {
    run: Parameters<typeof runOnDefaultRuntimeHost>[1];
    successTitle?: string;
    successDetail?: string;
    errorTitle: string;
    errorFallback: string;
    errorMessage?: (error: unknown) => string | undefined;
  }): Promise<boolean> {
    try {
      const result = await runOnDefaultRuntimeHost(
        services.runtimeHosts,
        mutation.run,
      );
      if (!mountedRef.current) return false;
      const hostIsCurrent = await isDefaultRuntimeHostCurrent(
        services.runtimeHosts,
        result.host,
      );
      if (!mountedRef.current || !hostIsCurrent) return false;
      await refreshRef.current({ shouldShowError: isSurfaceActive });
      const hostIsStillCurrent = await isDefaultRuntimeHostCurrent(
        services.runtimeHosts,
        result.host,
      );
      if (!mountedRef.current || !hostIsStillCurrent) return false;
      if (mountedRef.current && mutation.successTitle && isSurfaceActive()) {
        toastApi.success(mutation.successTitle, mutation.successDetail);
      }
      return true;
    } catch (error) {
      if (!mountedRef.current) return false;
      const operationHost = defaultRuntimeHostOperationHost(error);
      const hostIsCurrent = operationHost
        ? await isDefaultRuntimeHostCurrent(
            services.runtimeHosts,
            operationHost,
          )
        : true;
      if (!mountedRef.current || !hostIsCurrent) return false;
      if (isSurfaceActive()) {
        toastApi.error(
          mutation.errorTitle,
          mutation.errorMessage?.(error) ??
            localizedShellErrorMessage(error, mutation.errorFallback, uiLocale),
          undefined,
          defaultRuntimeHostDiagnosticTarget(error),
        );
      }
      return false;
    }
  }

  useEffect(() => {
    const unsubscribeChanges = services.scheduledTasks.subscribeChanges(() => {
      void refreshRef.current();
    });
    const unsubscribeDue = services.scheduledTasks.subscribeDue((task) => {
      void refreshRef.current();
      const currentCopy = notificationsCopyRef.current;
      toastApiRef.current.toast({
        title: currentCopy.scheduledTask,
        description: task.title,
        variant: 'info',
        duration: 8000,
        action: {
          label: currentCopy.viewScheduledTasks,
          onClick: () =>
            selectModuleRef.current({
              section: 'automations',
              module: 'scheduled-tasks',
            }),
        },
      });
    });
    return () => {
      unsubscribeChanges();
      unsubscribeDue();
    };
  }, [services.scheduledTasks]);

  return {
    scheduledTasks,
    createRequestNonce,
    openCreate() {
      selectModuleRef.current({
        section: 'automations',
        module: 'scheduled-tasks',
      });
      setCreateRequestNonce((current) => current + 1);
    },
    handleCreateRequest() {
      setCreateRequestNonce(0);
    },
    refresh,
    refreshSurface() {
      return refresh({ shouldShowError: isSurfaceActive });
    },
    create(input) {
      return runMutation({
        run: (host) => services.scheduledTasks.create(input, host),
        successTitle: copy.created,
        successDetail: input.title,
        errorTitle: copy.createFailed,
        errorFallback: copy.createFallback,
        errorMessage: (error) =>
          errorText(error).includes('SCHEDULED_TASK_INCOGNITO_ACTIVE')
            ? copy.createIncognitoBlocked
            : undefined,
      });
    },
    update(id, patch) {
      return runMutation({
        run: (host) => services.scheduledTasks.update(id, patch, host),
        successTitle: copy.saved,
        successDetail: patch.title,
        errorTitle: copy.saveFailed,
        errorFallback: copy.saveFallback,
      });
    },
    async toggle(id, enabled) {
      await runMutation({
        run: (host) => services.scheduledTasks.setEnabled(id, enabled, host),
        successTitle: enabled ? copy.enabled : copy.paused,
        errorTitle: copy.updateFailed,
        errorFallback: copy.updateFallback,
      });
    },
    async triggerNow(id) {
      const task = scheduledTasksRef.current.find((entry) => entry.id === id);
      await runMutation({
        run: (host) => services.scheduledTasks.triggerNow(id, host),
        successTitle: copy.triggered,
        successDetail: task?.title,
        errorTitle: copy.triggerFailed,
        errorFallback: copy.triggerFallback,
      });
    },
    async snooze(id) {
      const task = scheduledTasksRef.current.find((entry) => entry.id === id);
      await runMutation({
        run: (host) => services.scheduledTasks.snooze(id, host),
        successTitle: copy.snoozed,
        successDetail: task?.title,
        errorTitle: copy.snoozeFailed,
        errorFallback: copy.snoozeFallback,
      });
    },
    async clearRunHistory(id) {
      const task = scheduledTasksRef.current.find((entry) => entry.id === id);
      const confirmed = await toastApi.confirm({
        title: copy.clearTitle(task?.title ?? copy.task),
        description: copy.clearDescription,
        confirmLabel: copy.clear,
        cancelLabel: copy.cancel,
        destructive: true,
      });
      if (!confirmed || !isSurfaceActive()) return;
      await runMutation({
        run: (host) => services.scheduledTasks.clearRunHistory(id, host),
        successTitle: copy.cleared,
        successDetail: task?.title,
        errorTitle: copy.clearFailed,
        errorFallback: copy.clearFallback,
      });
    },
    async delete(id) {
      const task = scheduledTasksRef.current.find((entry) => entry.id === id);
      const confirmed = await toastApi.confirm({
        title: copy.deleteTitle(task?.title ?? copy.task),
        description: copy.deleteDescription,
        confirmLabel: copy.delete,
        cancelLabel: copy.cancel,
        destructive: true,
      });
      if (!confirmed || !isSurfaceActive()) return;
      await runMutation({
        run: (host) => services.scheduledTasks.delete(id, host),
        successTitle: copy.deleted,
        errorTitle: copy.deleteFailed,
        errorFallback: copy.deleteFallback,
      });
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}
