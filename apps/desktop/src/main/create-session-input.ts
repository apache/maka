/**
 * What a `sessions:create` request resolves to.
 *
 * #1433: these fields used to be derived in two places. `sessions:create`
 * took them from the renderer, and a second IPC (`quickChat:start`, built for
 * the first-run Quick Chat panel) derived them from a product `mode`. The
 * panel is gone, and what remained of the second IPC was a duplicate of the
 * first — same readiness gate, same connection resolution, same
 * `emitSessionsChanged('created')` — so only the derivation survived.
 *
 * It lives here as a pure function rather than inside the handler because the
 * handler is an `ipcMain.handle` closure no test can call. Every invariant
 * below — the mode's boundary outranking both the renderer's request and the
 * configured default, the refusal of a directly-requested `explore`, the
 * settings-backed fallback that must never reject — would otherwise only be
 * assertable by regex over the handler's source.
 */

import type {
  AppSettings,
  CollaborationMode,
  OrchestrationMode,
  PermissionMode,
  SessionStartMode,
} from '@maka/core';
import {
  DEEP_RESEARCH_SESSION_LABEL,
  DEFAULT_SESSION_NAME,
  isChatDefaultPermissionMode,
  isCollaborationMode,
  isOrchestrationMode,
} from '@maka/core';

import { resolveDefaultPermissionMode } from './permission-mode-default.js';

/**
 * The renderer names a product intent; main stays the sole authority on what
 * that intent means. A closed mapping rather than a passthrough, so nothing
 * the renderer sends can reach `explore` except the mode that earns it.
 */
interface SessionModeSeed {
  permissionMode: PermissionMode;
  name: string;
  labels: string[];
}

/**
 * Closed over `SessionStartMode`, not over an `if`: adding a member without a
 * seed is a compile error here, which is the only place that catches it. A
 * missing arm would otherwise degrade silently into "no mode at all" — a plain
 * session at the configured default, with the new mode's name, label and
 * boundary all quietly absent.
 */
const SESSION_MODE_SEEDS = {
  deep_research: {
    // Deep Research is a read-only exploration boundary, so it overrides the
    // user's configured default rather than seeding from it.
    permissionMode: 'explore',
    name: 'Deep Research',
    labels: [DEEP_RESEARCH_SESSION_LABEL],
  },
} satisfies Record<SessionStartMode, SessionModeSeed>;

/**
 * `unknown`, because this is an IPC boundary and the renderer's type is a
 * promise, not a guarantee. An unrecognized value confers nothing — it is not
 * a mode — and the caller falls through to an ordinary session, which is the
 * same session it would have got by not naming one.
 */
function sessionModeSeed(mode: unknown): SessionModeSeed | undefined {
  return typeof mode === 'string' && Object.hasOwn(SESSION_MODE_SEEDS, mode)
    ? SESSION_MODE_SEEDS[mode as SessionStartMode]
    : undefined;
}

/**
 * The part of a create request this module resolves. Everything else — cwd,
 * backend, connection, model, thinking level — stays the handler's.
 */
export interface CreateSessionRequest {
  mode?: SessionStartMode;
  permissionMode?: PermissionMode;
  collaborationMode?: CollaborationMode;
  orchestrationMode?: OrchestrationMode;
  name?: string;
  labels?: string[];
}

export interface ResolvedCreateSessionInput {
  permissionMode: PermissionMode;
  collaborationMode: CollaborationMode;
  orchestrationMode: OrchestrationMode;
  name: string;
  labels: string[] | undefined;
}

export async function resolveCreateSessionInput(
  input: CreateSessionRequest | undefined,
  deps: { readSettings: () => Promise<AppSettings> },
): Promise<ResolvedCreateSessionInput> {
  const modeSeed = sessionModeSeed(input?.mode);

  const collaborationMode = input?.collaborationMode ?? 'agent';
  if (!isCollaborationMode(collaborationMode)) {
    throw new TypeError('Invalid collaboration mode.');
  }
  const orchestrationMode = input?.orchestrationMode ?? 'default';
  if (!isOrchestrationMode(orchestrationMode)) {
    throw new TypeError('Invalid orchestration mode.');
  }
  // `explore` is a boundary a mode confers, never one a caller may open a
  // session at — core already spells that out as `ChatDefaultPermissionMode`
  // (the modes a user can pick). Refusing it here is what makes the seed the
  // only way in; `sessions:setPermissionMode` stays the separate, deliberate
  // path for moving an existing session (the quote companion uses it).
  if (input?.permissionMode !== undefined && !isChatDefaultPermissionMode(input.permissionMode)) {
    throw new TypeError('Invalid permission mode.');
  }

  return {
    permissionMode:
      modeSeed?.permissionMode ??
      input?.permissionMode ??
      (await resolveDefaultPermissionMode(deps.readSettings)),
    collaborationMode,
    orchestrationMode,
    name: modeSeed?.name ?? input?.name ?? DEFAULT_SESSION_NAME,
    // Merged, not replaced: a mode adds a label, it does not own the set. No
    // caller sends both today, and silently dropping the caller's would be the
    // surprising half of that.
    labels: modeSeed ? [...new Set([...(input?.labels ?? []), ...modeSeed.labels])] : input?.labels,
  };
}
