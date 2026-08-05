import { ipcMain } from "electron";
import type { WorkspacePrivacyContext } from "@maka/core";
import type { PlanReminderMainService } from "./plan-reminders-main.js";

interface PlanReminderIpcDeps {
  planReminders: PlanReminderMainService;
  getWorkspacePrivacyContext: () => Promise<WorkspacePrivacyContext>;
  ipcMain?: Pick<typeof ipcMain, "handle">;
}

export function registerPlanReminderIpc(deps: PlanReminderIpcDeps): void {
  const target = deps.ipcMain ?? ipcMain;
  target.handle("plans:list", () => deps.planReminders.list());
  target.handle("plans:create", async (_event, input: unknown) => {
    const privacy = await deps.getWorkspacePrivacyContext();
    if (privacy.incognitoActive) {
      throw new Error("PLAN_REMINDER_INCOGNITO_ACTIVE");
    }
    return deps.planReminders.create(input);
  });
  target.handle("plans:update", (_event, id: string, patch: unknown) =>
    deps.planReminders.update(id, patch),
  );
  target.handle("plans:setEnabled", (_event, id: string, enabled: boolean) =>
    deps.planReminders.setEnabled(id, enabled),
  );
  target.handle("plans:triggerNow", (_event, id: string) =>
    deps.planReminders.triggerNow(id),
  );
  target.handle("plans:snooze", (_event, id: string) =>
    deps.planReminders.snooze(id),
  );
  target.handle("plans:clearRunHistory", (_event, id: string) =>
    deps.planReminders.clearRunHistory(id),
  );
  target.handle("plans:delete", async (_event, id: string) => {
    await deps.planReminders.delete(id);
  });
}
