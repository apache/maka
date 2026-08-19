import type { PermissionMode } from '@maka/core/permission';
import type { SessionSummary } from '@maka/core/session';
import type { NewChatModel } from './shell-chat-model-selection';

export interface PendingSessionViewInput {
  sessionId: string;
  name: string;
  permissionMode: PermissionMode;
  /** Connection + model the next new task would start on, when one is offered. */
  newChatModel: NewChatModel | undefined;
  defaultConnectionSlug: string | null;
}

/**
 * The `SessionSummary` the chat view shows between "a session id became active"
 * and "its real summary arrived".
 *
 * The composer reads the connection and model straight off this object — the
 * model switcher's current value, the quote companion's target — so the
 * placeholder carries what the next new task would use. It used to claim
 * `backend: 'fake'` / `model: 'fake-model'`: a retired backend (#3211) and a
 * model no session ever had, which the switcher then failed to match.
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
    llmConnectionSlug: input.newChatModel?.llmConnectionSlug ?? input.defaultConnectionSlug ?? '',
    connectionLocked: false,
    model: input.newChatModel?.model ?? '',
    permissionMode: input.permissionMode,
  };
}
