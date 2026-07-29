import type { SessionManager } from '@maka/runtime';
import { assertDesktopExecutionBoundary } from './desktop-execution-admission.js';
import type { StreamEvents } from './session-stream.js';

type StartupResumeRuntime = Pick<
  SessionManager,
  | 'listSessions'
  | 'readExecutionBoundary'
  | 'planLatestAuthoritativeSafeBoundaryContinuation'
  | 'resumeSafeBoundaryContinuation'
>;

export async function resumeSafeBoundaryContinuationsOnStartup(
  runtime: StartupResumeRuntime,
  streamEvents: StreamEvents,
): Promise<void> {
  for (const session of await runtime.listSessions()) {
    const boundary = await runtime.readExecutionBoundary(session.id);
    try {
      assertDesktopExecutionBoundary(session.id, boundary);
    } catch {
      continue;
    }
    const plan = await runtime.planLatestAuthoritativeSafeBoundaryContinuation(session.id);
    if (!plan.continuation) continue;
    const iterator = runtime.resumeSafeBoundaryContinuation(plan.continuation);
    void streamEvents(session.id, iterator, {
      turnId: plan.continuation.turnId,
      goalBoundary: 'none',
    });
  }
}
