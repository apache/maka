/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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
import type { GoalControlAction, GoalProjection } from '@maka/runtime-host/protocol';

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
  /**
   * The current session's goal projection, or null when no goal is set.
   * Read from the live session projection (push-updated); subscribe to
   * subscribeGoalChanges for updates. Optional: drivers without a goal
   * authority leave goal UI hidden.
   */
  getGoal?(): GoalProjection | null;
  /**
   * Fires when the session's goal projection changes — set, settled, paused,
   * resumed, cleared, or when the attached session changes.
   */
  subscribeGoalChanges?(listener: (goal: GoalProjection | null) => void): () => void;
  /**
   * Applies a goal control action (pause/resume/clear) with optimistic
   * revision retry, mirroring the desktop client. Resolves with the resulting
   * projection, or null when no goal is armed (or the goal disappeared to a
   * concurrent control action mid-flight — for clear that is the desired end
   * state). Optional: drivers without a goal authority reject goal control.
   */
  controlGoal?(action: GoalControlAction): Promise<GoalProjection | null>;
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
