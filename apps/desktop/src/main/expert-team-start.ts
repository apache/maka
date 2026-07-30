/**
 * Expert-team session entry — a thin, dependency-injected handler so the
 * readiness gating and discriminated-union result can be unit-tested without
 * spinning up an Electron app. #1433 folded the sibling handler it was modeled
 * on (`quick-chat.ts`) into `sessions:create`; this one survives because it
 * also sends a first message, which session creation does not.
 *
 * Starting an expert team creates a normal session labeled
 * `mode:expert-team:<teamId>`. That label activates the team lead's persona and
 * the `expert_dispatch` tool (wired in `main.ts`); no other session state is
 * special. An unknown team id fails closed before any session is created.
 */

import type { OnboardingState, SessionSummary } from '@maka/core';
import { generalizedErrorMessageChinese } from '@maka/core';
import { isSessionWorkspaceUnavailableError } from './project-context-root.js';

export type ExpertTeamStartResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'unknown_team'; teamId: string }
  | { ok: false; reason: 'setup_required'; state: OnboardingState }
  | { ok: false; reason: 'workspace_unavailable' }
  | { ok: false; reason: 'send_failed'; message: string };

export interface ExpertTeamStartDeps {
  /** True when the team id is a known, dispatchable expert team. */
  isKnownTeam(teamId: string): boolean;
  /** Fresh derived onboarding state; re-read so a stale renderer snapshot cannot bypass the gate. */
  getOnboardingState(): Promise<OnboardingState>;
  /** Create a session bound to the derived ready default and labeled for the team. */
  createSession(input: {
    teamId: string;
    defaultConnectionSlug: string;
    defaultModel: string;
  }): Promise<SessionSummary>;
  /** Emit a session-created event so the sidebar refreshes. */
  emitCreated(sessionId: string): void;
  /** Pre-flight gate identical to the `sessions:send` path. */
  ensureCanSend(sessionId: string): Promise<void>;
  /** Send the first user message via the existing send path (fire-and-stream). */
  sendFirstMessage(sessionId: string, text: string): Promise<void>;
}

function readString(input: unknown, key: string): string {
  if (input && typeof input === 'object' && key in input) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

export async function handleExpertTeamStart(
  rawInput: unknown,
  deps: ExpertTeamStartDeps,
): Promise<ExpertTeamStartResult> {
  const teamId = readString(rawInput, 'teamId').trim();
  const trimmed = readString(rawInput, 'prompt').trim();

  // Fail closed before touching any state if the team is unknown.
  if (!teamId || !deps.isKnownTeam(teamId)) {
    return { ok: false, reason: 'unknown_team', teamId };
  }

  const state = await deps.getOnboardingState();
  if (state.kind !== 'ready_empty' && state.kind !== 'ready_with_history') {
    return { ok: false, reason: 'setup_required', state };
  }

  let session: SessionSummary;
  try {
    session = await deps.createSession({
      teamId,
      defaultConnectionSlug: state.defaultConnectionSlug,
      defaultModel: state.defaultModel,
    });
    deps.emitCreated(session.id);
  } catch (error) {
    if (isSessionWorkspaceUnavailableError(error)) {
      return { ok: false, reason: 'workspace_unavailable' };
    }
    return {
      ok: false,
      reason: 'send_failed',
      message: generalizedErrorMessageChinese(error, '无法创建会话，请稍后再试。'),
    };
  }

  // Empty prompt: open the labeled session without sending a message.
  if (!trimmed) {
    return { ok: true, sessionId: session.id };
  }

  try {
    await deps.ensureCanSend(session.id);
    await deps.sendFirstMessage(session.id, trimmed);
    return { ok: true, sessionId: session.id };
  } catch (error) {
    if (isSessionWorkspaceUnavailableError(error)) {
      return { ok: false, reason: 'workspace_unavailable' };
    }
    return {
      ok: false,
      reason: 'send_failed',
      message: generalizedErrorMessageChinese(error, '会话已创建但发送失败，请重试。'),
    };
  }
}
