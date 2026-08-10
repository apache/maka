/**
 * Project a Runtime Host agent Automation into the scheduled-tasks list shape
 * (`PlanReminder`) so the desktop Automations page can show agent-created
 * cron/heartbeat jobs next to UI-created plan reminders.
 *
 * Storage for plan reminders never sees these rows — they are assembled when
 * the renderer refreshes the combined list.
 */

import type { AutomationKind, AutomationSchedule, AutomationStatus } from './automation.js';
import type {
  PlanReminder,
  PlanReminderAgentOrigin,
  PlanReminderRunRecord,
  PlanReminderSchedule,
  PlanReminderStatus,
} from './plan-reminders.js';

/** Minimal automation fields needed for the scheduled-tasks projection. */
export interface AgentAutomationProjectionSource {
  readonly id: string;
  readonly kind: AutomationKind;
  readonly name: string;
  readonly status: AutomationStatus;
  readonly prompt: string;
  readonly sessionId: string;
  readonly schedule: AutomationSchedule;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly nextFireAt: number | null;
  readonly lastFireAt: number | null;
  readonly lastRunId: string | null;
  readonly fireCount: number;
  readonly lastError: string | null;
  readonly durable: boolean;
}

const AGENT_REMINDER_ID_PREFIX = 'agent-automation:';

export function agentAutomationReminderId(automationId: string): string {
  return `${AGENT_REMINDER_ID_PREFIX}${automationId}`;
}

export function parseAgentAutomationReminderId(reminderId: string): string | undefined {
  if (!reminderId.startsWith(AGENT_REMINDER_ID_PREFIX)) return undefined;
  const automationId = reminderId.slice(AGENT_REMINDER_ID_PREFIX.length);
  return automationId.length > 0 ? automationId : undefined;
}

export function isAgentAutomationPlanReminder(
  reminder: Pick<PlanReminder, 'agentOrigin' | 'id'>,
): boolean {
  return Boolean(reminder.agentOrigin) || parseAgentAutomationReminderId(reminder.id) !== undefined;
}

export function projectAgentAutomationAsPlanReminder(
  automation: AgentAutomationProjectionSource,
): PlanReminder {
  const status = mapAutomationStatus(automation.status);
  const enabled = automation.status === 'active';
  const schedule = mapAutomationSchedule(automation);
  const lastRun = mapAutomationLastRun(automation);
  const agentOrigin: PlanReminderAgentOrigin = {
    automationId: automation.id,
    sessionId: automation.sessionId,
    kind: automation.kind,
    durable: automation.durable === true,
  };
  return {
    id: agentAutomationReminderId(automation.id),
    title: automation.name,
    note: automation.prompt,
    schedule,
    // Agent automations execute as Runtime Host turns; local delivery is only
    // a list-row placeholder (there is no toast/bot payload for them here).
    delivery: { channel: 'local' },
    status,
    enabled,
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
    ...(typeof automation.nextFireAt === 'number' ? { nextRunAt: automation.nextFireAt } : {}),
    ...(lastRun ? { lastRun, runs: [lastRun] } : { runs: [] }),
    runCount: automation.fireCount,
    agentOrigin,
  };
}

/**
 * Merge persisted plan reminders with agent-automation projections.
 * Real plan-reminder rows win on id collision (should not happen in practice
 * because agent rows use the `agent-automation:` id prefix).
 */
export function mergePlanRemindersWithAgentAutomations(
  planReminders: readonly PlanReminder[],
  automations: readonly AgentAutomationProjectionSource[],
): PlanReminder[] {
  const projected = automations
    // Heartbeats are session-private polling; the scheduled-tasks page is for
    // standalone work. Show cron always, and durable jobs of either kind so a
    // future durable form still surfaces.
    .filter((automation) => automation.kind === 'cron' || automation.durable === true)
    .map(projectAgentAutomationAsPlanReminder);
  const seen = new Set(planReminders.map((reminder) => reminder.id));
  const merged = [...planReminders];
  for (const row of projected) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged;
}

function mapAutomationStatus(status: AutomationStatus): PlanReminderStatus {
  if (status === 'active') return 'scheduled';
  if (status === 'paused') return 'paused';
  return 'completed';
}

function mapAutomationSchedule(automation: AgentAutomationProjectionSource): PlanReminderSchedule {
  const schedule = automation.schedule;
  if (schedule.type === 'cron') {
    return {
      kind: 'cron',
      startAt: automation.createdAt,
      expression: schedule.expression,
    };
  }
  if (schedule.type === 'once') {
    const runAt =
      typeof automation.nextFireAt === 'number'
        ? automation.nextFireAt
        : automation.createdAt + schedule.delaySeconds * 1000;
    return { kind: 'once', runAt };
  }
  // interval: the list only needs a countdown anchor — nextFireAt is authoritative.
  const runAt =
    typeof automation.nextFireAt === 'number'
      ? automation.nextFireAt
      : automation.createdAt + schedule.seconds * 1000;
  return { kind: 'once', runAt };
}

function mapAutomationLastRun(
  automation: AgentAutomationProjectionSource,
): PlanReminderRunRecord | undefined {
  if (typeof automation.lastFireAt !== 'number') return undefined;
  const failed = typeof automation.lastError === 'string' && automation.lastError.length > 0;
  return {
    id: automation.lastRunId ?? `automation-fire-${automation.fireCount}`,
    at: automation.lastFireAt,
    status: failed ? 'failed' : 'triggered',
    message: failed ? automation.lastError! : 'Agent automation ran.',
  };
}
