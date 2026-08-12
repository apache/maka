import { dialog } from 'electron';
import type {
  RuntimeHostRestartableConflict,
  RuntimeHostRestartDecision,
  RuntimeHostUpgradePrompts,
  RuntimeHostWaitConflict,
  RuntimeHostWaitDecision,
} from './runtime-host-desktop-owner.js';
import { whileAwaitingPerson } from './startup-step.js';

export const runtimeHostUpgradePrompts: RuntimeHostUpgradePrompts = {
  restartable: confirmRestartableRuntimeHost,
  waitOnly: confirmWaitOnlyRuntimeHost,
};

async function confirmRestartableRuntimeHost(
  conflict: RuntimeHostRestartableConflict,
): Promise<RuntimeHostRestartDecision> {
  const response = await showRuntimeHostUpgradeDialog(conflict, true);
  if (response === 0) return 'restart';
  if (response === 1) return 'wait';
  return 'cancel';
}

async function confirmWaitOnlyRuntimeHost(
  conflict: RuntimeHostWaitConflict,
): Promise<RuntimeHostWaitDecision> {
  const response = await showRuntimeHostUpgradeDialog(conflict, false);
  return response === 0 ? 'wait' : 'cancel';
}

type RuntimeHostUpgradeConflict = RuntimeHostRestartableConflict | RuntimeHostWaitConflict;

async function showRuntimeHostUpgradeDialog(
  conflict: RuntimeHostUpgradeConflict,
  canRestart: boolean,
): Promise<number> {
  const activity = conflict.handshake?.activity;
  const hasWork =
    (activity?.activeOperations ?? 0) > 0 || (activity?.residencies.length ?? 0) > 0;
  const buttons = canRestart
    ? ['Restart Runtime Host', 'Wait', 'Cancel Startup']
    : ['Wait', 'Cancel Startup'];
  const restartId = canRestart ? 0 : -1;
  const waitId = canRestart ? 1 : 0;
  const cancelId = canRestart ? 2 : 1;
  const { response } = await whileAwaitingPerson(
    dialog.showMessageBox({
      type: 'warning',
      title: 'Older Runtime Host is running',
      message: 'Another Runtime Host process still owns this workspace.',
      detail: formatRuntimeHostUpgradeActivity(conflict),
      buttons,
      defaultId: hasWork || !canRestart ? waitId : restartId,
      cancelId,
      noLink: true,
    }),
  );
  return response;
}

function formatRuntimeHostUpgradeActivity(conflict: RuntimeHostUpgradeConflict): string {
  const activity = conflict.handshake?.activity;
  const lines: string[] = [];
  if (activity) {
    const ageMinutes = Math.max(1, Math.round(activity.processUptimeSeconds / 60));
    lines.push(`Running for about ${ageMinutes} ${ageMinutes === 1 ? 'minute' : 'minutes'}`);
    if (activity.connections > 0) {
      lines.push(`${activity.connections} other client(s) are still connected`);
    }
    if (activity.activeOperations > 0) {
      lines.push(`${activity.activeOperations} operation(s) are running`);
    }
    for (const residency of activity.residencies) {
      lines.push(`${runtimeHostActivityLabel(residency.label)}: ${residency.count}`);
    }
  } else {
    lines.push('This Host version cannot report its background activity.');
  }
  lines.push(
    '',
    'Restarting preserves durable state, but it can interrupt in-flight external work.',
  );
  if (conflict.kind !== 'upgrade_required' || !conflict.restartable) {
    lines.push('Exit the process that owns this Host to replace it safely.');
  }
  lines.push('If you wait, Maka will continue automatically when this Host exits.');
  return lines.join('\n');
}

function runtimeHostActivityLabel(label: string): string {
  const names: Record<string, string> = {
    goal: 'Goal',
    'scheduled-task': 'Scheduled Task',
    'daily-review': 'Daily Review',
    'hosted-execution': 'Active execution',
    'runtime-resource': 'Runtime resource',
    'agent-graph': 'Agent Graph',
    'agent-graph-supervisor': 'Agent Graph',
  };
  return names[label] ?? 'Other background activity';
}
