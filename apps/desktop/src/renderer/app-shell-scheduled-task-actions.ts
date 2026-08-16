import type { Dispatch, SetStateAction } from "react";
import type { CreateScheduledTaskInput, ScheduledTask, UpdateScheduledTaskInput } from '@maka/core/scheduled-task';
import type { UiLocale } from '@maka/core/ui-locale';
import { getShellRemainingCopy } from "./locales/shell-remaining-copy.js";
import { localizedShellErrorMessage } from "./locales/shell-copy.js";

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

type ScheduledTaskCreateInput = Omit<CreateScheduledTaskInput, "createdBy">;

export interface AppShellScheduledTaskActions {
  refreshScheduledTasks(options?: {
    shouldShowError?: () => boolean;
  }): Promise<void>;
  createScheduledTask(input: ScheduledTaskCreateInput): Promise<boolean>;
  updateScheduledTask(id: string, patch: UpdateScheduledTaskInput): Promise<boolean>;
  toggleScheduledTask(id: string, enabled: boolean): Promise<void>;
  triggerScheduledTaskNow(id: string): Promise<void>;
  snoozeScheduledTask(id: string): Promise<void>;
  clearScheduledTaskRunHistory(id: string): Promise<void>;
  deleteScheduledTask(id: string): Promise<void>;
}

export function createAppShellScheduledTaskActions(deps: {
  uiLocale: UiLocale;
  getScheduledTasks: () => readonly ScheduledTask[];
  isScheduledTasksSurfaceActive: () => boolean;
  setScheduledTasks: Dispatch<SetStateAction<ScheduledTask[]>>;
  toastApi: ToastApi;
}): AppShellScheduledTaskActions {
  const {
    uiLocale,
    getScheduledTasks,
    isScheduledTasksSurfaceActive,
    setScheduledTasks,
    toastApi,
  } = deps;
  const copy = getShellRemainingCopy(uiLocale).scheduledTaskActions;

  async function refreshScheduledTasks(
    options: { shouldShowError?: () => boolean } = {},
  ) {
    try {
      const next = await window.maka.scheduledTasks.list();
      setScheduledTasks(next);
    } catch (error) {
      if (options.shouldShowError?.() ?? true) {
        toastApi.error(
          copy.refreshFailed,
          localizedShellErrorMessage(error, copy.refreshFallback, uiLocale),
        );
      }
    }
  }

  async function runScheduledTaskMutation(mutation: {
    run: () => Promise<unknown>;
    successTitle?: string;
    successDetail?: string;
    errorTitle: string;
    errorFallback: string;
    errorMessage?: (error: unknown) => string | undefined;
  }): Promise<boolean> {
    try {
      await mutation.run();
      await refreshScheduledTasks({
        shouldShowError: isScheduledTasksSurfaceActive,
      });
      if (mutation.successTitle && isScheduledTasksSurfaceActive()) {
        toastApi.success(mutation.successTitle, mutation.successDetail);
      }
      return true;
    } catch (error) {
      if (isScheduledTasksSurfaceActive()) {
        toastApi.error(
          mutation.errorTitle,
          mutation.errorMessage?.(error) ??
            localizedShellErrorMessage(error, mutation.errorFallback, uiLocale),
        );
      }
      return false;
    }
  }

  return {
    refreshScheduledTasks,
    createScheduledTask(input) {
      return runScheduledTaskMutation({
        run: () => window.maka.scheduledTasks.create(input),
        successTitle: copy.created,
        successDetail: input.title,
        errorTitle: copy.createFailed,
        errorFallback: copy.createFallback,
        errorMessage: (error) =>
          errorMessage(error).includes("SCHEDULED_TASK_INCOGNITO_ACTIVE")
            ? copy.createIncognitoBlocked
            : undefined,
      });
    },
    updateScheduledTask(id, patch) {
      return runScheduledTaskMutation({
        run: () => window.maka.scheduledTasks.update(id, patch),
        successTitle: copy.saved,
        successDetail: patch.title,
        errorTitle: copy.saveFailed,
        errorFallback: copy.saveFallback,
      });
    },
    async toggleScheduledTask(id, enabled) {
      await runScheduledTaskMutation({
        run: () => window.maka.scheduledTasks.setEnabled(id, enabled),
        successTitle: enabled ? copy.enabled : copy.paused,
        errorTitle: copy.updateFailed,
        errorFallback: copy.updateFallback,
      });
    },
    async triggerScheduledTaskNow(id) {
      const task = getScheduledTasks().find((entry) => entry.id === id);
      await runScheduledTaskMutation({
        run: () => window.maka.scheduledTasks.triggerNow(id),
        successTitle: copy.triggered,
        successDetail: task?.title,
        errorTitle: copy.triggerFailed,
        errorFallback: copy.triggerFallback,
      });
    },
    async snoozeScheduledTask(id) {
      const task = getScheduledTasks().find((entry) => entry.id === id);
      await runScheduledTaskMutation({
        run: () => window.maka.scheduledTasks.snooze(id),
        successTitle: copy.snoozed,
        successDetail: task?.title,
        errorTitle: copy.snoozeFailed,
        errorFallback: copy.snoozeFallback,
      });
    },
    async clearScheduledTaskRunHistory(id) {
      const task = getScheduledTasks().find((entry) => entry.id === id);
      const ok = await toastApi.confirm({
        title: copy.clearTitle(task?.title ?? copy.task),
        description: copy.clearDescription,
        confirmLabel: copy.clear,
        cancelLabel: copy.cancel,
        destructive: true,
      });
      if (!ok) return;
      await runScheduledTaskMutation({
        run: () => window.maka.scheduledTasks.clearRunHistory(id),
        successTitle: copy.cleared,
        successDetail: task?.title,
        errorTitle: copy.clearFailed,
        errorFallback: copy.clearFallback,
      });
    },
    async deleteScheduledTask(id) {
      const task = getScheduledTasks().find((entry) => entry.id === id);
      const ok = await toastApi.confirm({
        title: copy.deleteTitle(task?.title ?? copy.task),
        description: copy.deleteDescription,
        confirmLabel: copy.delete,
        cancelLabel: copy.cancel,
        destructive: true,
      });
      if (!ok) return;
      await runScheduledTaskMutation({
        run: () => window.maka.scheduledTasks.delete(id),
        successTitle: copy.deleted,
        errorTitle: copy.deleteFailed,
        errorFallback: copy.deleteFallback,
      });
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}
