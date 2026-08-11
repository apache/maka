import type { SessionSummary } from '@maka/core/session';
import type { LiveTurnProjection } from '@maka/ui';

/**
 * Which sessions' turn transients are safe to drop, i.e. whose turn the
 * authority says is over.
 *
 * A session's `status` alone cannot say that. It reads `active` both before the
 * runtime's `running` write — which lands only at the end of `AgentRun.begin`,
 * announced by nothing until this renderer's own send is confirmed — and after
 * the turn ends. A list refreshed inside that window is byte-identical to one
 * taken after the turn finished, so reading it as a settle drops the arm the
 * send just created, taking the whole first-token wait with it (the projection
 * gets rebuilt by the first content event as `'streamed'`, downgrading the
 * prominent "正在处理…" to the calm "继续中…").
 *
 * The arm's own `unconfirmed` bit supplies the missing identity: while it is
 * set, this renderer has sent a turn the authority has not yet answered about,
 * and no session-level status may be read as an answer. It is cleared by the
 * first word about that exact turn — its start, its failure to start, its end,
 * or any of its events — so a status change caused by some OTHER turn (another
 * client, a scheduled task) cannot release it early.
 */
export function settledSessionTransientIds(options: {
  activeId?: string;
  sessions: readonly SessionSummary[];
  liveTurnBySession: Readonly<Record<string, LiveTurnProjection>>;
}): string[] {
  return options.sessions.flatMap((session) => {
    // The live runs first: a persisted status can disagree with them in both
    // directions — it is written after the run starts and can be left behind
    // entirely by a crash — so anything the runtime still reports as running
    // keeps its transients regardless of what the header says.
    if (session.runningTurnIds?.length) return [];
    if (session.status === 'running' || session.status === 'waiting_for_user') return [];
    const projection = options.liveTurnBySession[session.id];
    if (projection?.unconfirmed) return [];
    if (session.id === options.activeId && projection?.terminal) return [];
    return [session.id];
  });
}
