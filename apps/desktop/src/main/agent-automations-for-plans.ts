/**
 * Collect agent Automations visible to the scheduled-tasks (plan-reminders)
 * page. Durable crons outlive their creator session and are listed against
 * every session that can still query the host; we dedupe by automation id.
 *
 * When the workspace has no sessions yet (or every list call fails), fall back
 * to a read-only SQLite snapshot so durable crons still appear in the UI.
 */

import type { AutomationDefinition } from '@maka/core/automation';
import type { AutomationProjection } from '@maka/runtime-host/protocol';
import { createSqliteAutomationAuthority } from '@maka/storage';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';

export type AgentAutomationListClient = Pick<
  DesktopRuntimeHostClient,
  'listSessions' | 'listAutomations'
>;

export async function listAgentAutomationsForScheduledTasks(
  client: AgentAutomationListClient,
  options: { workspaceRoot?: string } = {},
): Promise<AutomationProjection[]> {
  const sessions = await client.listSessions().catch(() => []);
  // Prefer live sessions first so ownership/sessionId is as fresh as possible,
  // then fall back to archived ones — durable crons remain queryable there.
  const ordered = [...sessions].sort((a, b) => {
    const aArchived = a.isArchived ? 1 : 0;
    const bArchived = b.isArchived ? 1 : 0;
    if (aArchived !== bArchived) return aArchived - bArchived;
    return a.id.localeCompare(b.id);
  });

  const byId = new Map<string, AutomationProjection>();
  for (const session of ordered) {
    let automations: AutomationProjection[];
    try {
      automations = await client.listAutomations(session.id);
    } catch {
      // A single bad session must not hide the rest of the catalog.
      continue;
    }
    for (const automation of automations) {
      if (automation.kind !== 'cron' && automation.durable !== true) continue;
      if (!byId.has(automation.id)) {
        byId.set(automation.id, automation);
      }
    }
  }

  if (byId.size === 0 && options.workspaceRoot) {
    for (const automation of readDurableAutomationsFromStore(options.workspaceRoot)) {
      if (!byId.has(automation.id)) byId.set(automation.id, automation);
    }
  }

  return [...byId.values()].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
  });
}

function readDurableAutomationsFromStore(workspaceRoot: string): AutomationProjection[] {
  try {
    const authority = createSqliteAutomationAuthority(workspaceRoot);
    try {
      return authority
        .read()
        .automations.filter((automation) => automation.kind === 'cron' || automation.durable === true)
        .map(projectDefinition);
    } finally {
      authority.close();
    }
  } catch {
    return [];
  }
}

function projectDefinition(automation: AutomationDefinition): AutomationProjection {
  return {
    id: automation.id,
    kind: automation.kind,
    name: automation.name,
    status: automation.status,
    prompt: automation.prompt,
    sessionId: automation.sessionId,
    schedule: automation.schedule,
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
    nextFireAt: automation.nextFireAt,
    lastFireAt: automation.lastFireAt,
    lastRunId: automation.lastRunId,
    fireCount: automation.fireCount,
    maxFires: automation.maxFires,
    expiresAt: automation.expiresAt,
    lastError: automation.lastError,
    consecutiveFailures: automation.consecutiveFailures,
    durable: automation.durable === true,
    deferredFireCount: automation.deferredFireCount ?? 0,
    firePending: false,
    waiting: automation.waiting ?? null,
  };
}
