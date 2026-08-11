import type { AgentGraphScheduleReconciliationResult } from './stream-graph-schedule-reconcile.js';
import type { AgentGraphClientSnapshot } from './stream-graph-read-model.js';
import {
  isAgentSwarmSupervisorCheckpoint,
  projectAgentSwarmStatus,
} from './agent-swarm-status-tool.js';

export function renderDelegateModePrompt(): string {
  return [
    '<orchestration_mode>',
    '# Orchestration Mode: Delegate',
    'Delegate Mode is active. You are the conversation-facing main agent and remain responsive while durable worker tasks execute in background child Sessions.',
    'For work that is more than a quick conversational response, call agent_list, then submit bounded work with update_agent_graph. Treat each graph work item as a durable background task with an explicit objective, scope, constraints, and expected result.',
    'After scheduling work, acknowledge what was delegated and end this turn normally. Do not poll, sleep, wait for child output, or call yield_agent_graph. The host will wake you at a durable task checkpoint.',
    'You may keep accepting user messages while workers run. Use view_agent_graph or agent_swarm_status when the user asks for status, update_agent_graph to add, replace, or stop work, and agent_output view=result only for committed worker results.',
    'On a host checkpoint, inspect task state, read committed results, decide whether follow-up work is needed, and either schedule it or report the result. If more work is scheduled, report the decision and end normally; never wait synchronously.',
    'Keep the delegate graph open across task batches so later user messages can submit more work. Do not finish the graph merely because the current batch settled; finish it only when the user explicitly ends the delegate workflow or the host is retiring the session.',
    'Use new_preset with an exact subagent_id when possible. Keep worker tasks non-overlapping and avoid delegating trivial chat.',
    '</orchestration_mode>',
  ].join('\n');
}

export function shouldWakeDelegateSupervisor(
  _rootSessionId: string,
  _result: AgentGraphScheduleReconciliationResult | undefined,
  snapshot: AgentGraphClientSnapshot,
): boolean | undefined {
  if (snapshot.orchestrationMode !== 'delegate') return undefined;
  return snapshot.reconciliationFailures.length > 0 || isAgentSwarmSupervisorCheckpoint(snapshot);
}

export function renderDelegateSupervisorWake(
  _rootSessionId: string,
  snapshot: AgentGraphClientSnapshot,
  result?: AgentGraphScheduleReconciliationResult,
):
  | {
      text: string;
      displayText: string;
      orchestrationMode: 'delegate';
    }
  | undefined {
  if (snapshot.orchestrationMode !== 'delegate') return undefined;
  const status = projectAgentSwarmStatus(snapshot);
  const attentionWorkIds = status.items
    .filter((item) => ['blocked', 'failed', 'aborted', 'cancelled'].includes(item.status))
    .map((item) => item.workId);
  return {
    text: [
      '<delegate-task-checkpoint>',
      `Background task set ${status.swarmId} reached ${status.status}.`,
      `Reconciliation status: ${result?.status ?? 'checkpoint'}.`,
      ...(attentionWorkIds.length > 0
        ? [`Attention work ids: ${attentionWorkIds.join(', ')}.`]
        : []),
      'Call agent_swarm_status for compact task status. Read committed completed results with agent_output view=result.',
      'Replace or stop failed work when useful. Otherwise report the committed result and keep the delegate graph open for later task batches.',
      'If you schedule more background work, report that decision and end this turn normally. Do not poll, sleep, wait synchronously, or call yield_agent_graph.',
      'Do not finish the graph merely because this task batch settled; finish it only when the user explicitly ends the delegate workflow or the host is retiring the session.',
      'When the useful work is complete, synthesize the result for the user and end normally.',
      '</delegate-task-checkpoint>',
    ].join('\n'),
    displayText: `Delegated tasks ${status.status.replace('_', ' ')}.`,
    orchestrationMode: 'delegate',
  };
}
