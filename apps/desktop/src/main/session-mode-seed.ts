/**
 * Product-level "new session mode" → the session fields it implies.
 *
 * #1433: this used to live behind a second session-creation IPC
 * (`quickChat:start`), built for the first-run Quick Chat panel. That
 * panel is gone, and what remained of the IPC was a duplicate of
 * `sessions:create` — same readiness gate, same connection resolution,
 * same `emitSessionsChanged('created')` — differing only in that it
 * derived `permissionMode` / `name` / `labels` from a `mode` instead of
 * taking them from the renderer.
 *
 * So only the derivation survives, as a pure function `sessions:create`
 * applies. The renderer names the product intent ("Deep Research"); main
 * stays the sole authority on what that intent means. The renderer must
 * not be able to reach `explore` by simply asking for it under a mode it
 * did not earn — hence a closed mapping rather than a passthrough.
 */

import type { PermissionMode, QuickChatMode } from '@maka/core';
import { DEEP_RESEARCH_SESSION_LABEL } from '@maka/core';

export interface SessionModeSeed {
  /**
   * Set only when the mode *forces* a permission mode. Deep Research is
   * a read-only exploration boundary, so it overrides the user's
   * configured default rather than seeding from it.
   */
  permissionMode?: PermissionMode;
  name: string;
  labels: string[];
}

export function sessionModeSeed(mode: QuickChatMode | undefined): SessionModeSeed | undefined {
  if (mode !== 'deep_research') return undefined;
  return {
    permissionMode: 'explore',
    name: 'Deep Research',
    labels: [DEEP_RESEARCH_SESSION_LABEL],
  };
}
