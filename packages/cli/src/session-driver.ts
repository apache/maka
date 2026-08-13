import { realpath } from 'node:fs/promises';
import type { QueueEnqueueOutcome, SessionEvent } from '@maka/core/events';
import type { OrchestrationMode } from '@maka/core/orchestration';
import type { PermissionMode } from '@maka/core/permission';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { TurnOrchestration } from '@maka/core/runtime-inputs';
import type { UserQuestionResponse } from '@maka/core/user-question';
import type { ContextDiagnostics } from '@maka/runtime/context-diagnostics';
import type { SkillInvocationResult } from '@maka/core/skill-invocation';

export interface MakaSessionMoveResult {
  previousCwd: string;
  cwd: string;
  changed: boolean;
  oldCwdDirty?: boolean;
}

export interface MakaSessionSwitchOptions {
  /** Explicitly relocate the durable Session cwd before attaching to it. */
  relocateCwd?: string;
}

export type InspectCwdChanges = (cwd: string) => Promise<boolean | undefined>;

export interface RewindTarget {
  turnId: string;
  label: string;
}

export interface MakaSessionSwitchResult {
  summary: SessionSummary;
  messages: StoredMessage[];
  activeTurn?: MakaPreparedSessionTurn;
  relocation?: MakaSessionMoveResult;
}

export interface MakaSessionRewindResult extends MakaSessionSwitchResult {
  prompt: string;
}

export interface MakaPreparedSessionTurn {
  sessionId: string;
  turnId: string;
  runId?: string;
  events: AsyncIterable<SessionEvent>;
  summary?: SessionSummary;
  skillInvocation?: SkillInvocationResult;
}

export interface MakaAttachedSessionTurn extends MakaPreparedSessionTurn {
  messages: StoredMessage[];
  summary: SessionSummary;
}

export interface MakaPreparePromptOptions {
  turnId?: string;
  modelText?: string;
  turnOrchestration?: TurnOrchestration;
  maxSteps?: number;
}

export class SkillInvocationBlockedError extends Error {
  constructor(readonly skillInvocation: SkillInvocationResult) {
    super('Explicit Skill invocation could not be resolved');
    this.name = 'SkillInvocationBlockedError';
  }
}

export interface MakaSessionDriver {
  listSessions(): Promise<SessionSummary[]>;
  getSessionResumeAvailability?(session: SessionSummary): Promise<SessionResumeAvailability>;
  preparePrompt(
    prompt: string,
    options?: MakaPreparePromptOptions,
  ): Promise<MakaPreparedSessionTurn>;
  compactSession(): AsyncIterable<SessionEvent>;
  resumeLatest?(): AsyncIterable<SessionEvent>;
  steer?(text: string): Promise<QueueEnqueueOutcome>;
  queueMessage?(text: string): Promise<QueueEnqueueOutcome>;
  takePendingFollowup?(): Promise<string | null>;
  retractQueued?(): Promise<string>;
  respondToSandboxBoundary(response: SandboxBoundaryResponse): Promise<void>;
  respondToUserQuestion?(response: UserQuestionResponse): Promise<void>;
  setModel(model: string, connectionSlug?: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel | undefined): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setOrchestrationMode?(mode: OrchestrationMode): Promise<void>;
  renameSession(name: string): Promise<string | void>;
  moveSession?(cwd: string): Promise<MakaSessionMoveResult>;
  switchSession(
    sessionId: string,
    options?: MakaSessionSwitchOptions,
  ): Promise<MakaSessionSwitchResult>;
  listRewindTargets(): Promise<RewindTarget[]>;
  rewindToTurn(turnId: string): Promise<MakaSessionRewindResult>;
  subscribeStartedTurns?(listener: (turn: MakaAttachedSessionTurn) => void): () => void;
  subscribeResolvedInteractions?(
    listener: (sessionId: string, requestId: string) => void,
  ): () => void;
  subscribeTranscriptReplacements?(
    listener: (
      sessionId: string,
      turnId: string,
      messages: StoredMessage[],
      reason: MakaTranscriptReplacementReason,
    ) => void,
  ): () => void;
  startNewSession(): void;
  stop(): Promise<void>;
  getSessionId(): string | null;
  getContextDiagnostics?(): Promise<ContextDiagnostics>;
  getOrchestrationMode?(): OrchestrationMode;
  getPermissionMode?(): PermissionMode;
}

export type MakaTranscriptReplacementReason = 'terminal' | 'reconnect';

export type SessionResumeAvailability = { available: true } | { available: false; reason: string };

export async function inspectSessionResumeAvailability(
  session: SessionSummary,
): Promise<SessionResumeAvailability> {
  if (!session.cwd) return { available: false, reason: 'Missing working directory' };
  try {
    await realpath(session.cwd);
    return { available: true };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { available: false, reason: 'Working directory no longer exists' };
    }
    throw error;
  }
}
