/**
 * Quick Chat handler (PR110b).
 *
 * Extracted from `main.ts` so the discriminated-union behavior can be
 * unit-tested without spinning up an Electron app. Deps are injected;
 * the live wiring in main.ts binds them to the real runtime + stores.
 *
 * Scope (#1433): this opens an EMPTY session in a given mode. It does
 * not carry a first message. It used to, for the first-run Quick Chat
 * panel — a second composer that duplicated the real one and drifted
 * from it. That panel is gone: the one Composer owns drafting, Skill
 * invocation and sending, and creates its own session on first send
 * (`app-shell-chat-actions.ts`). What is left here is the one thing
 * that path cannot express — starting a session in a non-default mode
 * (Deep Research, from the command palette) before any text exists.
 *
 * Contract:
 *   - Input shape is `{ mode?: QuickChatMode }`; anything else is
 *     ignored, and there is no `connectionSlug` / `model` override.
 *   - Result is a discriminated union; the raw
 *     `ChatConfigurationReason` enum never reaches the renderer.
 *   - Readiness is re-derived here, never trusted from the renderer.
 */

import type { OnboardingState, QuickChatMode, SessionSummary } from '@maka/core';
import { generalizedErrorMessageChinese, normalizeQuickChatMode } from '@maka/core';
import { isSessionWorkspaceUnavailableError } from './project-context-root.js';

/**
 * PR110b: Quick Chat IPC result. The renderer pattern-matches on
 * `ok` + `reason` to route to the right surface.
 *
 * @xuan PR110b review: the success branch carries ONLY `sessionId`.
 */
export type QuickChatResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'setup_required'; state: OnboardingState }
  | { ok: false; reason: 'workspace_unavailable' }
  | { ok: false; reason: 'create_failed'; message: string };

export interface QuickChatDeps {
  /**
   * Fresh derived state. The handler always re-reads this so a stale
   * snapshot from the renderer cannot bypass the readiness gate.
   */
  getOnboardingState(): Promise<OnboardingState>;
  /**
   * Create a new session bound to the derived ready default. The
   * caller's `createSession` should re-run `requireReadyConnection`
   * internally to close the race window between snapshot read and
   * session create.
   */
  createSession(input: {
    defaultConnectionSlug: string;
    defaultModel: string;
    mode: QuickChatMode;
  }): Promise<SessionSummary>;
  /**
   * Emit a session-created event on the global bus (the renderer
   * subscribes to this to refresh the sidebar).
   */
  emitCreated(sessionId: string): void;
}

export async function handleQuickChatStart(
  rawInput: unknown,
  deps: QuickChatDeps,
): Promise<QuickChatResult> {
  const mode = normalizeQuickChatMode(
    rawInput && typeof rawInput === 'object' && 'mode' in rawInput
      ? (rawInput as { mode?: unknown }).mode
      : undefined,
  );

  // Fresh state to defeat any stale snapshot the renderer might hold.
  const state = await deps.getOnboardingState();
  if (state.kind !== 'ready_empty' && state.kind !== 'ready_with_history') {
    return { ok: false, reason: 'setup_required', state };
  }

  let session: SessionSummary;
  try {
    session = await deps.createSession({
      defaultConnectionSlug: state.defaultConnectionSlug,
      defaultModel: state.defaultModel,
      mode,
    });
  } catch (error) {
    if (isSessionWorkspaceUnavailableError(error)) {
      return { ok: false, reason: 'workspace_unavailable' };
    }
    return {
      ok: false,
      reason: 'create_failed',
      message: generalizedErrorMessageChinese(error, '无法创建会话，请稍后再试。'),
    };
  }

  deps.emitCreated(session.id);
  return { ok: true, sessionId: session.id };
}
