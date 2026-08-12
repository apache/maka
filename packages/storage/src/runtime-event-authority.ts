import { WORKSPACE_AUTHORITY_SESSION_ID } from '@maka/core/workspace-version-authority';

import { type RuntimeEvent } from '@maka/core/runtime-event';

/**
 * Generic and non-workspace writers must never create workspace authority
 * facts or occupy the store-owned authority stream. SQLite's dedicated
 * baseline writer is the only caller that may cross this boundary.
 */
export function assertNoReservedWorkspaceAuthorityAppend(event: RuntimeEvent): void {
  if (event.actions?.workspaceFact !== undefined) {
    throw new Error('Workspace facts require the atomic workspace version authority writer');
  }
  if (event.sessionId === WORKSPACE_AUTHORITY_SESSION_ID) {
    throw new Error('RuntimeEvent targets the reserved workspace authority stream');
  }
}
