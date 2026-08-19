import type { PermissionMode } from '@maka/core/permission';
import type { SessionSummary } from '@maka/core/session';

export interface PendingSessionViewInput {
  sessionId: string;
  name: string;
  permissionMode: PermissionMode;
}

/**
 * The `SessionSummary` the chat view shows between "a session id became active"
 * and "its real summary arrived".
 *
 * The connection and model read empty because they are genuinely unknown: this
 * fallback covers every active id without a loaded summary, not just a freshly
 * created task, so the session behind it may be an existing one bound to any
 * model. An empty pair matches no offered choice, which is how the model
 * switcher's current-value and no-op comparisons read "not yet known" — naming
 * a plausible model instead would let a switch onto that model be silently
 * dropped as a no-op against a session that was never on it.
 *
 * It used to say `backend: 'fake'` / `model: 'fake-model'`, borrowing a retired
 * backend (#3211) to mean "not loaded". The unknown-ness is the same; the
 * borrowed name is gone.
 */
export function pendingSessionView(input: PendingSessionViewInput): SessionSummary {
  return {
    id: input.sessionId,
    name: input.name,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: '',
    connectionLocked: false,
    model: '',
    permissionMode: input.permissionMode,
  };
}
