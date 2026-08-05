import type { Dispatch, SetStateAction } from "react";
import type {
  PlanReminder,
  PlanReminderDeliveryTarget,
  PlanReminderRecurrence,
  UiLocale,
} from "@maka/core";
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

type PlanReminderCreateInput = {
  title: string;
  note?: string;
  runAt: number;
  recurrence?: PlanReminderRecurrence;
  cronExpression?: string;
  delivery?: PlanReminderDeliveryTarget;
};

type PlanReminderPatch = {
  title?: string;
  note?: string;
  runAt?: number;
  recurrence?: PlanReminderRecurrence;
  cronExpression?: string;
  delivery?: PlanReminderDeliveryTarget;
  enabled?: boolean;
};

export interface AppShellPlanActions {
  refreshPlanReminders(options?: {
    shouldShowError?: () => boolean;
  }): Promise<void>;
  createPlanReminder(input: PlanReminderCreateInput): Promise<boolean>;
  updatePlanReminder(id: string, patch: PlanReminderPatch): Promise<boolean>;
  togglePlanReminder(id: string, enabled: boolean): Promise<void>;
  triggerPlanReminderNow(id: string): Promise<void>;
  snoozePlanReminder(id: string): Promise<void>;
  clearPlanReminderRunHistory(id: string): Promise<void>;
  deletePlanReminder(id: string): Promise<void>;
}

export function createAppShellPlanActions(deps: {
  uiLocale: UiLocale;
  getPlanReminders: () => readonly PlanReminder[];
  isAutomationsSurfaceActive: () => boolean;
  setPlanReminders: Dispatch<SetStateAction<PlanReminder[]>>;
  toastApi: ToastApi;
}): AppShellPlanActions {
  const {
    uiLocale,
    getPlanReminders,
    isAutomationsSurfaceActive,
    setPlanReminders,
    toastApi,
  } = deps;
  const copy = getShellRemainingCopy(uiLocale).planActions;

  async function refreshPlanReminders(
    options: { shouldShowError?: () => boolean } = {},
  ) {
    try {
      const next = await window.maka.plans.list();
      setPlanReminders(next);
    } catch (error) {
      if (options.shouldShowError?.() ?? true) {
        toastApi.error(
          copy.refreshFailed,
          localizedShellErrorMessage(error, copy.refreshFallback, uiLocale),
        );
      }
    }
  }

  async function runPlanReminderMutation(mutation: {
    run: () => Promise<unknown>;
    successTitle?: string;
    successDetail?: string;
    errorTitle: string;
    errorFallback: string;
    errorMessage?: (error: unknown) => string | undefined;
  }): Promise<boolean> {
    try {
      await mutation.run();
      await refreshPlanReminders({
        shouldShowError: isAutomationsSurfaceActive,
      });
      if (mutation.successTitle && isAutomationsSurfaceActive()) {
        toastApi.success(mutation.successTitle, mutation.successDetail);
      }
      return true;
    } catch (error) {
      if (isAutomationsSurfaceActive()) {
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
    refreshPlanReminders,
    createPlanReminder(input) {
      return runPlanReminderMutation({
        run: () => window.maka.plans.create(input),
        successTitle: copy.created,
        successDetail: input.title,
        errorTitle: copy.createFailed,
        errorFallback: copy.createFallback,
        errorMessage: (error) =>
          errorMessage(error).includes("PLAN_REMINDER_INCOGNITO_ACTIVE")
            ? copy.createIncognitoBlocked
            : undefined,
      });
    },
    updatePlanReminder(id, patch) {
      return runPlanReminderMutation({
        run: () => window.maka.plans.update(id, patch),
        successTitle: copy.saved,
        successDetail: patch.title,
        errorTitle: copy.saveFailed,
        errorFallback: copy.saveFallback,
      });
    },
    async togglePlanReminder(id, enabled) {
      await runPlanReminderMutation({
        run: () => window.maka.plans.setEnabled(id, enabled),
        successTitle: enabled ? copy.enabled : copy.paused,
        errorTitle: copy.updateFailed,
        errorFallback: copy.updateFallback,
      });
    },
    async triggerPlanReminderNow(id) {
      const reminder = getPlanReminders().find((entry) => entry.id === id);
      await runPlanReminderMutation({
        run: () => window.maka.plans.triggerNow(id),
        successTitle: copy.triggered,
        successDetail: reminder?.title,
        errorTitle: copy.triggerFailed,
        errorFallback: copy.triggerFallback,
      });
    },
    async snoozePlanReminder(id) {
      const reminder = getPlanReminders().find((entry) => entry.id === id);
      await runPlanReminderMutation({
        run: () => window.maka.plans.snooze(id),
        successTitle: copy.snoozed,
        successDetail: reminder?.title,
        errorTitle: copy.snoozeFailed,
        errorFallback: copy.snoozeFallback,
      });
    },
    async clearPlanReminderRunHistory(id) {
      const reminder = getPlanReminders().find((entry) => entry.id === id);
      const ok = await toastApi.confirm({
        title: copy.clearTitle(reminder?.title ?? copy.reminder),
        description: copy.clearDescription,
        confirmLabel: copy.clear,
        cancelLabel: copy.cancel,
        destructive: true,
      });
      if (!ok) return;
      await runPlanReminderMutation({
        run: () => window.maka.plans.clearRunHistory(id),
        successTitle: copy.cleared,
        successDetail: reminder?.title,
        errorTitle: copy.clearFailed,
        errorFallback: copy.clearFallback,
      });
    },
    async deletePlanReminder(id) {
      const reminder = getPlanReminders().find((entry) => entry.id === id);
      const ok = await toastApi.confirm({
        title: copy.deleteTitle(reminder?.title ?? copy.reminder),
        description: copy.deleteDescription,
        confirmLabel: copy.delete,
        cancelLabel: copy.cancel,
        destructive: true,
      });
      if (!ok) return;
      await runPlanReminderMutation({
        run: () => window.maka.plans.delete(id),
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
