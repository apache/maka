/**
 * The Session's mode as one value, and how it lands in the two fields that
 * persist it.
 *
 * `collaborationMode` and `orchestrationMode` are independent fields, but the
 * modes they can legally spell are not independent: Plan strips the
 * subagent-category tools and the agent-graph tools (`plan-mode.ts`), which is
 * what Swarm and Graph are made of, so `plan` + anything is a combination the
 * runtime cannot honour. This module is the one place that mapping lives.
 */
import type { ComposerSessionMode } from '@maka/ui';
import type { SessionModeFields } from '../preload/bridge-contract.js';

export type { SessionModeFields };

/**
 * Every mode names BOTH fields, on purpose: a transition is then computed from
 * where it is going, never from where the renderer thinks it currently is. A
 * Session summary that has not loaded yet, or a record written by an older
 * build, cannot make a write land between two modes.
 */
export const SESSION_MODE_FIELDS: Readonly<Record<ComposerSessionMode, SessionModeFields>> =
  Object.freeze({
    default: { collaborationMode: 'agent', orchestrationMode: 'default' },
    plan: { collaborationMode: 'plan', orchestrationMode: 'default' },
    swarm: { collaborationMode: 'agent', orchestrationMode: 'swarm' },
    graph: { collaborationMode: 'agent', orchestrationMode: 'graph' },
  });

/** Whether a persisted pair is a combination the runtime can honour. */
export function isLegalSessionModePair(fields: SessionModeFields): boolean {
  return fields.collaborationMode !== 'plan' || fields.orchestrationMode === 'default';
}

/**
 * The mode a persisted pair reads as. Plan wins when both are set — no Session
 * reaches that through this control, but a record written by an older build or
 * by a model's own mode change still has to read as one of the four.
 */
export function sessionModeOf(fields: Partial<SessionModeFields>): ComposerSessionMode {
  if ((fields.collaborationMode ?? 'agent') === 'plan') return 'plan';
  const orchestration = fields.orchestrationMode ?? 'default';
  return orchestration === 'swarm' || orchestration === 'graph' ? orchestration : 'default';
}
