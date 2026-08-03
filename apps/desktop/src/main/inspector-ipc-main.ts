import type { IpcMain } from 'electron';
import { decodeModelCallAttempt, type ModelCallAttempt } from '@maka/core/model-call-attempt';
import { MODEL_CALL_ATTEMPT_EVENT_TYPE } from '@maka/core/model-call-attempt';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { SessionTrace } from '@maka/core/session-trace';
import { tryResult } from '@maka/core/result';
import { projectSessionTrace } from '@maka/runtime';

/**
 * Read-only projection of one session's causal trace for the Inspector (#1625).
 *
 * Reads two ledgers and writes nothing. The AgentRun stream is the authority
 * for canonical metering — not the Usage read model, which is range-queried and
 * carries no session predicate — and `readSessionRuntimeEvents` supplies the
 * causal structure the metering ledger knows nothing about.
 */
export interface InspectorIpcDeps {
  ipcMain: Pick<IpcMain, 'handle'>;
  readSessionRuntimeEvents: (sessionId: string) => Promise<readonly RuntimeEvent[]>;
  listSessionRuns: (sessionId: string) => Promise<readonly { readonly runId: string }[]>;
  readRunEvents: (
    sessionId: string,
    runId: string,
  ) => Promise<readonly { readonly type: string; readonly data?: unknown }[]>;
}

export function registerInspectorIpc(deps: InspectorIpcDeps): void {
  deps.ipcMain.handle('inspector:trace', (_event, sessionId: string) =>
    tryResult(async () => await readSessionTrace(deps, sessionId), 'INSPECTOR_TRACE_FAILED'),
  );
}

export async function readSessionTrace(
  deps: Omit<InspectorIpcDeps, 'ipcMain'>,
  sessionId: string,
): Promise<SessionTrace> {
  const [runtimeEvents, runs] = await Promise.all([
    deps.readSessionRuntimeEvents(sessionId),
    deps.listSessionRuns(sessionId),
  ]);

  const modelCallAttempts: ModelCallAttempt[] = [];
  let unreadableRecords = 0;
  // Per run rather than per session: the authority stream is keyed that way, so
  // reading it run by run is reading it as it is stored, not reshaping it.
  const runEvents = await Promise.all(
    runs.map((run) => deps.readRunEvents(sessionId, run.runId)),
  );
  for (const events of runEvents) {
    for (const event of events) {
      if (event.type !== MODEL_CALL_ATTEMPT_EVENT_TYPE) continue;
      try {
        modelCallAttempts.push(decodeModelCallAttempt(event.data));
      } catch {
        // A record that will not decode is spend this trace cannot show.
        // Counted so the gap is visible; dropping it silently is the failure
        // this projection exists to avoid.
        unreadableRecords += 1;
      }
    }
  }

  return projectSessionTrace({
    sessionId,
    runtimeEvents,
    modelCallAttempts,
    ...(unreadableRecords > 0 ? { unreadableRecords } : {}),
  });
}
