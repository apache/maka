import type { SessionManager } from '@maka/runtime';
import { isDesktopAdmissibleExecutionBoundary } from './desktop-execution-admission.js';
import type { StreamEvents } from './session-stream.js';

type StartupResumeRuntime = Pick<
  SessionManager,
  | 'listSessions'
  | 'readExecutionBoundary'
  | 'planLatestAuthoritativeSafeBoundaryContinuation'
  | 'resumeSafeBoundaryContinuation'
>;

/**
 * Resume every session whose latest turn stopped at a boundary it can safely
 * continue past.
 *
 * One session per iteration, and one session's failure costs only that session.
 * Every step here can throw for reasons local to a single session — its record
 * can be gone by the time this pass reads it, its boundary row can be
 * unreadable — and an unguarded loop turns that into "no session after this one
 * gets recovered", which is a much larger outage than the one that caused it.
 * The caller only knows the whole pass failed, so a fault in the oldest session
 * would silently strand every newer one.
 *
 * An externally isolated session is skipped rather than reported: that is the
 * admission rule holding, not a fault. Asking
 * `isDesktopAdmissibleExecutionBoundary` instead of catching the assert keeps
 * the two apart, so `logError` only ever carries something that went wrong.
 */
export async function resumeSafeBoundaryContinuationsOnStartup(
  runtime: StartupResumeRuntime,
  streamEvents: StreamEvents,
  logError?: (message: string, error: unknown) => void,
): Promise<void> {
  for (const session of await runtime.listSessions()) {
    try {
      const boundary = await runtime.readExecutionBoundary(session.id);
      if (!isDesktopAdmissibleExecutionBoundary(boundary)) continue;
      const plan = await runtime.planLatestAuthoritativeSafeBoundaryContinuation(session.id);
      if (!plan.continuation) continue;
      const iterator = runtime.resumeSafeBoundaryContinuation(plan.continuation);
      void streamEvents(session.id, iterator, {
        turnId: plan.continuation.turnId,
        goalBoundary: 'none',
      });
    } catch (error) {
      logError?.(`[startup] safe-boundary resume failed for session ${session.id}:`, error);
    }
  }
}
