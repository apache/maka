import { ipcMain } from "electron";
import {
  mergePlanRemindersWithAgentAutomations,
  parseAgentAutomationReminderId,
  type WorkspacePrivacyContext,
} from "@maka/core";
import type { AutomationProjection } from "@maka/runtime-host/protocol";
import {
  listAgentAutomationsForScheduledTasks,
  type AgentAutomationListClient,
} from "./agent-automations-for-plans.js";
import type { PlanReminderMainService } from "./plan-reminders-main.js";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";

interface PlanReminderIpcDeps {
  planReminders: PlanReminderMainService;
  getWorkspacePrivacyContext: () => Promise<WorkspacePrivacyContext>;
  /**
   * When present, `plans:list` merges durable agent Automations into the
   * scheduled-tasks catalog so agent-created crons appear in the desktop UI.
   */
  runtimeHostClient?: AgentAutomationListClient &
    Pick<DesktopRuntimeHostClient, "mutateAutomation">;
  /** Workspace root for the SQLite fallback when no sessions can query the host. */
  workspaceRoot?: string;
  ipcMain?: Pick<typeof ipcMain, "handle">;
}

export function registerPlanReminderIpc(deps: PlanReminderIpcDeps): void {
  const target = deps.ipcMain ?? ipcMain;
  target.handle("plans:list", async () => {
    const planReminders = await deps.planReminders.list();
    const client = deps.runtimeHostClient;
    if (!client) return planReminders;
    let automations: AutomationProjection[] = [];
    try {
      automations = await listAgentAutomationsForScheduledTasks(client, {
        workspaceRoot: deps.workspaceRoot,
      });
    } catch {
      // Host down / not ready: still return UI-created plan reminders.
      return planReminders;
    }
    return mergePlanRemindersWithAgentAutomations(planReminders, automations);
  });
  target.handle("plans:create", async (_event, input: unknown) => {
    const privacy = await deps.getWorkspacePrivacyContext();
    if (privacy.incognitoActive) {
      throw new Error("PLAN_REMINDER_INCOGNITO_ACTIVE");
    }
    return deps.planReminders.create(input);
  });
  target.handle("plans:update", async (_event, id: string, patch: unknown) => {
    await rejectAgentAutomationMutation(id, "update", deps);
    return deps.planReminders.update(id, patch);
  });
  target.handle("plans:setEnabled", async (_event, id: string, enabled: boolean) => {
    const automationId = parseAgentAutomationReminderId(id);
    if (automationId) {
      return mutateAgentAutomationEnabled(deps, id, automationId, enabled);
    }
    return deps.planReminders.setEnabled(id, enabled);
  });
  target.handle("plans:triggerNow", async (_event, id: string) => {
    await rejectAgentAutomationMutation(id, "trigger", deps);
    return deps.planReminders.triggerNow(id);
  });
  target.handle("plans:snooze", async (_event, id: string) => {
    await rejectAgentAutomationMutation(id, "snooze", deps);
    return deps.planReminders.snooze(id);
  });
  target.handle("plans:clearRunHistory", async (_event, id: string) => {
    await rejectAgentAutomationMutation(id, "clear history for", deps);
    return deps.planReminders.clearRunHistory(id);
  });
  target.handle("plans:delete", async (_event, id: string) => {
    const automationId = parseAgentAutomationReminderId(id);
    if (automationId) {
      await deleteAgentAutomation(deps, id, automationId);
      return;
    }
    await deps.planReminders.delete(id);
  });
}

async function rejectAgentAutomationMutation(
  id: string,
  verb: string,
  _deps: PlanReminderIpcDeps,
): Promise<void> {
  void _deps;
  if (!parseAgentAutomationReminderId(id)) return;
  // Agent rows are never in the plan-reminder store — id prefix is enough.
  throw new Error(
    `Cannot ${verb} an agent automation through the plan-reminder editor. Pause, resume, or delete it instead.`,
  );
}

async function mutateAgentAutomationEnabled(
  deps: PlanReminderIpcDeps,
  reminderId: string,
  automationId: string,
  enabled: boolean,
) {
  void reminderId;
  const client = deps.runtimeHostClient;
  if (!client) throw new Error("Runtime Host is not available for agent automations.");
  const automations = await listAgentAutomationsForScheduledTasks(client, {
    workspaceRoot: deps.workspaceRoot,
  });
  const automation = automations.find((entry) => entry.id === automationId);
  if (!automation) throw new Error(`No such agent automation: ${automationId}`);
  if (enabled && automation.status === "active") {
    return mergePlanRemindersWithAgentAutomations([], [automation])[0]!;
  }
  if (!enabled && automation.status === "paused") {
    return mergePlanRemindersWithAgentAutomations([], [automation])[0]!;
  }
  if (enabled && automation.status !== "paused") {
    throw new Error("Only paused agent automations can be resumed.");
  }
  if (!enabled && automation.status !== "active") {
    throw new Error("Only active agent automations can be paused.");
  }
  const sessionId = await resolveAutomationManageSessionId(client, automation.sessionId);
  const result = await client.mutateAutomation({
    kind: enabled ? "resume" : "pause",
    sessionId,
    automationId,
  });
  if (result.kind !== "committed" || !result.automation) {
    throw new Error(
      result.kind === "rejected"
        ? `Agent automation ${enabled ? "resume" : "pause"} rejected: ${result.reason}`
        : `Agent automation ${enabled ? "resume" : "pause"} failed.`,
    );
  }
  return mergePlanRemindersWithAgentAutomations([], [result.automation])[0]!;
}

async function deleteAgentAutomation(
  deps: PlanReminderIpcDeps,
  reminderId: string,
  automationId: string,
): Promise<void> {
  void reminderId;
  const client = deps.runtimeHostClient;
  if (!client) throw new Error("Runtime Host is not available for agent automations.");
  const automations = await listAgentAutomationsForScheduledTasks(client, {
    workspaceRoot: deps.workspaceRoot,
  });
  const automation = automations.find((entry) => entry.id === automationId);
  if (!automation) throw new Error(`No such agent automation: ${automationId}`);
  const sessionId = await resolveAutomationManageSessionId(client, automation.sessionId);
  const result = await client.mutateAutomation({
    kind: "delete",
    sessionId,
    automationId,
  });
  if (result.kind === "rejected") {
    throw new Error(`Agent automation delete rejected: ${result.reason}`);
  }
}

/**
 * Durable automations remain manageable from any session, but the host still
 * requires a real session id on the mutate call. Prefer the creator when it
 * still exists; otherwise any live session; otherwise any archived one.
 */
async function resolveAutomationManageSessionId(
  client: AgentAutomationListClient,
  preferredSessionId: string,
): Promise<string> {
  const sessions = await client.listSessions().catch(() => []);
  if (sessions.some((session) => session.id === preferredSessionId)) {
    return preferredSessionId;
  }
  const live = sessions.find((session) => !session.isArchived);
  if (live) return live.id;
  if (sessions[0]) return sessions[0].id;
  // Last resort: creator id (host will surface not_found if it is truly gone).
  return preferredSessionId;
}
