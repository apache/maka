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

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import { DEFAULT_SESSION_NAME } from '@maka/core/session-name';
import {
  decodeStoredMessage as decodePersistedStoredMessage,
  deriveTurnRecords,
  userFacingText,
  type SessionSummary,
  type StoredMessage,
} from '@maka/core/session';
import { markPersisted } from '@maka/core/persisted-value';
import {
  type ActiveInteractionRequestEvent,
  type QueueEnqueueOutcome,
  type SessionEvent,
  type ShellRunUpdate,
} from '@maka/core/events';
import { isSideConversationSession } from '@maka/core/side-conversation';
import {
  createSessionCopyCleanupAuthority,
  type SessionCopyCleanupAuthority,
} from '@maka/storage/session-copy-cleanup';

import type { OrchestrationMode } from '@maka/core/orchestration';
import type { PermissionMode } from '@maka/core/permission';

import { executionBoundaryDisplayMode } from '@maka/core/sandbox-boundary';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { SkillInvocationResult } from '@maka/core/skill-invocation';
import type { UserQuestionResponse } from '@maka/core/user-question';
import type { ContextDiagnostics } from '@maka/runtime/context-diagnostics';
import { isRuntimeHostTerminalTurn as isTerminalTurn } from '@maka/runtime-host/adapter';
import type { DirectRequestOperationKey, RuntimeHostConnection } from '@maka/runtime-host/client';
import {
  projectSessionCatalogSummary,
  readRuntimeHostResources,
  readRuntimeHostSessions,
  RuntimeHostOperationError,
} from '@maka/runtime-host/client';
import {
  InteractionPendingSnapshot,
  OperationInput,
  OperationOutput,
  SessionCatalogItem,
  SessionCatalogProjection,
  SessionUpdateResult,
  SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  WorkspaceTarget,
  type GoalControlAction,
  type GoalProjection,
} from '@maka/runtime-host/protocol';
import {
  RuntimeHostSessionChannel,
  type RuntimeHostSessionChannelOpenResult,
} from './runtime-host-session-channel.js';
import type {
  InspectCwdChanges,
  MakaAttachedSessionTurn,
  MakaSideConversationCloseResult,
  MakaSideConversationOpenResult,
  MakaPreparePromptOptions,
  MakaPreparedSessionTurn,
  MakaSessionDriver,
  MakaSessionMoveResult,
  MakaSessionRewindResult,
  MakaSessionSwitchOptions,
  MakaSessionSwitchResult,
  MakaTranscriptReplacementReason,
  CreateSessionRequest,
  RewindTarget,
  SessionResumeAvailability,
} from './session-driver.js';
import { inspectSessionResumeAvailability, SkillInvocationBlockedError } from './session-driver.js';
import {
  cwdRank,
  firstLine,
  inspectGitCwdChanges,
  resolveMoveCwd,
} from './session-driver-policy.js';
const decodeStoredMessage = (value: unknown): StoredMessage =>
  decodePersistedStoredMessage(markPersisted<StoredMessage>(value));
const MAX_CATALOG_ATTEMPTS = 3;

/** Optimistic-control retries for goal pause/resume/clear (mirrors the desktop client). */
const GOAL_CONTROL_MAX_ATTEMPTS = 3;

export interface RuntimeHostMakaSessionDriverInput {
  connection: RuntimeHostSessionDriverConnection;
  cwd: string;
  workspace?: WorkspaceTarget;
  llmConnectionSlug: string;
  model: string;
  /**
   * The Host's configured chat default at launch, for display only.
   *
   * It is never sent on create — omitting the field is what lets the Host stay
   * the authority — but a client that shows "the mode the next Session will
   * start in" needs a value before any Session exists.
   */
  prospectivePermissionMode?: PermissionMode;
  orchestrationMode?: OrchestrationMode;
  newId?: () => string;
  now?: () => number;
  inspectCwdChanges?: InspectCwdChanges;
  executionLocation?: { readonly kind: 'client_path' } | { readonly kind: 'host' };
  /** Client-local durable lease parent for temporary TUI conversation copies. */
  sessionCopyCleanupRoot?: string;
}

type RuntimeHostSessionDriverConnection = Pick<
  RuntimeHostConnection,
  'rootId' | 'hostEpoch' | 'openSessionSubscription' | 'request'
>;

export interface RuntimeHostMakaSessionDriver extends MakaSessionDriver {
  createSession(input: CreateSessionRequest): Promise<SessionSummary>;
  readMessages(): Promise<StoredMessage[]>;
  resumeLatest(): AsyncIterable<SessionEvent>;
  subscribePendingInteractions(listener: (pending: InteractionPendingSnapshot) => void): () => void;
  subscribeStartedTurns(listener: (turn: MakaAttachedSessionTurn) => void): () => void;
  subscribeResolvedInteractions(
    listener: (sessionId: string, requestId: string) => void,
  ): () => void;
  subscribeTranscriptReplacements(
    listener: (
      sessionId: string,
      turnId: string,
      messages: readonly StoredMessage[],
      reason: MakaTranscriptReplacementReason,
    ) => void,
  ): () => void;
  listShellRunUpdates(sessionId: string): Promise<ShellRunUpdate[]>;
  subscribeShellRunUpdates(listener: (update: ShellRunUpdate) => void): () => void;
  recoverSideConversations(): Promise<void>;
  cleanupOwnedSideConversations(): Promise<void>;
}

export function createRuntimeHostMakaSessionDriver(
  input: RuntimeHostMakaSessionDriverInput,
): RuntimeHostMakaSessionDriver {
  return new RuntimeHostMakaSessionDriverImpl(input);
}

class RuntimeHostMakaSessionDriverImpl implements RuntimeHostMakaSessionDriver {
  readonly #connection: RuntimeHostSessionDriverConnection;
  readonly #newId: () => string;
  readonly #now: () => number;
  readonly #inspectCwdChanges: InspectCwdChanges;
  readonly #executionLocation: NonNullable<RuntimeHostMakaSessionDriverInput['executionLocation']>;
  readonly #sessionCopyCleanup: SessionCopyCleanupAuthority | undefined;
  readonly moveSession: MakaSessionDriver['moveSession'];
  #sessionId: string | null = null;
  #workspace: { target?: WorkspaceTarget; hostCwd: string };
  #model: string;
  #llmConnectionSlug: string;
  #thinkingLevel: ThinkingLevel | undefined;
  // What a Session created right now would start in, for display only. Never
  // sent on create: an omitted field is what makes the Host's `chatDefaults`
  // the authority. Refreshed on `/new` because that default can change — and
  // showing the previous Session's mode there is the one direction that can
  // report Auto while the Host creates with full access.
  #prospectivePermissionMode: PermissionMode | undefined;
  // The user's explicit choice for the Session being created, before it
  // exists. Cleared by `startNewSession` so a previous Session's elevation
  // cannot leak into a fresh one (#3020).
  #permissionMode: PermissionMode | undefined;
  #activeBoundaryDisplayMode: PermissionMode | undefined;
  #orchestrationMode: OrchestrationMode;
  #channel: RuntimeHostSessionChannel | undefined;
  #hiddenTranscriptThroughTurnId: string | undefined;
  #channelOpening: { sessionId: string; promise: Promise<RuntimeHostSessionChannel> } | undefined;
  readonly #startedTurnReattachTails = new Map<number, Promise<void>>();
  #sessionGeneration = 0;
  #channelGeneration = 0;
  #transcriptRefreshSequence = 0;
  readonly #startedTurnListeners = new Set<(turn: MakaAttachedSessionTurn) => void>();
  readonly #goalListeners = new Set<(goal: GoalProjection | null) => void>();
  readonly #pendingInteractionListeners = new Set<(pending: InteractionPendingSnapshot) => void>();
  readonly #claimedTurnIds = new Set<string>();
  readonly #shellRunListeners = new Set<(update: ShellRunUpdate) => void>();
  readonly #resolvedInteractionListeners = new Set<
    (sessionId: string, requestId: string) => void
  >();
  readonly #transcriptListeners = new Set<
    (
      sessionId: string,
      turnId: string,
      messages: readonly StoredMessage[],
      reason: MakaTranscriptReplacementReason,
    ) => void
  >();

  constructor(input: RuntimeHostMakaSessionDriverInput) {
    this.#connection = input.connection;
    this.#newId = input.newId ?? randomUUID;
    this.#now = input.now ?? Date.now;
    this.#inspectCwdChanges = input.inspectCwdChanges ?? inspectGitCwdChanges;
    this.#executionLocation = input.executionLocation ?? { kind: 'client_path' };
    this.#sessionCopyCleanup = input.sessionCopyCleanupRoot
      ? createSessionCopyCleanupAuthority({
          // rootId is the durable Host authority identity. HostEpoch would
          // strand cleanup across an ordinary Host restart, while one shared
          // Client root lets a different Host erase this Host's recovery lease.
          workspaceRoot: join(input.sessionCopyCleanupRoot, this.#connection.rootId),
          removeSession: (sessionId) => this.#removeSessionCopy(sessionId),
          resumeSessionCopy: (creation) => this.#resumeSessionCopy(creation),
          processId: `tui:${process.pid}`,
          isOwnerProcessActive: isTuiProcessActive,
        })
      : undefined;
    this.moveSession =
      this.#executionLocation.kind === 'host' ? undefined : (cwd) => this.#moveSession(cwd);
    this.#workspace = {
      ...(input.workspace
        ? { target: input.workspace }
        : this.#executionLocation.kind === 'client_path'
          ? { target: { kind: 'host_path' as const, path: input.cwd } }
          : {}),
      hostCwd: input.cwd,
    };
    this.#model = input.model;
    this.#llmConnectionSlug = input.llmConnectionSlug;
    this.#prospectivePermissionMode = input.prospectivePermissionMode;
    this.#orchestrationMode = input.orchestrationMode ?? 'default';
  }

  readMessages(): Promise<StoredMessage[]> {
    const hiddenThroughTurnId = this.#hiddenTranscriptThroughTurnId;
    return loadCurrentMessages(this.#connection, this.#requireSession('read messages')).then(
      (messages) => visibleTranscriptMessages(messages, hiddenThroughTurnId),
    );
  }

  async createSession(input: CreateSessionRequest): Promise<SessionSummary> {
    if (this.#sessionId) throw new Error('Cannot create a Session while another is active.');
    if (!input.model) throw new Error('Runtime Host Session creation requires an explicit model');
    this.#workspace = {
      target: workspaceTargetForCreate(this.#workspace, input, this.#executionLocation),
      hostCwd: input.cwd,
    };
    this.#llmConnectionSlug = input.llmConnectionSlug;
    this.#model = input.model;
    this.#thinkingLevel = input.thinkingLevel;
    // An omitted mode stays omitted: the Host applies its configured default.
    // Substituting a literal `ask` here would make the CLI a second authority
    // over the starting boundary and silently override that default.
    this.#permissionMode = input.permissionMode;
    const session = await this.#createSession(input.name ?? DEFAULT_SESSION_NAME);
    return projectSessionCatalogSummary(session);
  }

  async listSessions(): Promise<SessionSummary[]> {
    const sessions = (await readRuntimeHostSessions(this.#connection))
      .flatMap(representableSession)
      .filter((session) => !isSideConversationSession(session.labels))
      .map(projectSessionCatalogSummary);
    if (this.#executionLocation.kind === 'host') return sessions;
    return sessions
      .map((session, index) => ({ session, index }))
      .sort((left, right) => {
        const cwdDelta =
          cwdRank(left.session, this.#workspace.hostCwd) -
          cwdRank(right.session, this.#workspace.hostCwd);
        return cwdDelta !== 0 ? cwdDelta : left.index - right.index;
      })
      .map(({ session }) => session);
  }

  getSessionResumeAvailability(session: SessionSummary): Promise<SessionResumeAvailability> {
    return inspectRuntimeHostSessionResumeAvailability(session, this.#executionLocation);
  }

  async preparePrompt(
    prompt: string,
    options: MakaPreparePromptOptions = {},
  ): Promise<MakaPreparedSessionTurn> {
    const sessionId = await this.#ensureSession();
    const sessionGeneration = this.#sessionGeneration;
    const configuration = await this.#loadConfiguration(sessionId);
    this.#assertCurrentSession(sessionId, sessionGeneration);
    const channel = await this.#ensureChannel(sessionId);
    this.#assertCurrentSession(sessionId, sessionGeneration);
    this.#adoptLoadedConfiguration(configuration);
    const turnId = options.turnId ?? this.#newId();
    this.#claimedTurnIds.add(turnId);
    const events = channel.eventsForTurn(turnId);
    const modelText = options.modelText ?? prompt;
    try {
      const startInput = {
        sessionId,
        turnId,
        content: {
          text: modelText,
          ...(modelText === prompt ? {} : { displayText: prompt }),
        },
        ...(options.turnOrchestration ? { turnOrchestration: options.turnOrchestration } : {}),
        ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
      };
      const result = await this.#connection.request('turn.start', startInput);
      if (result.kind === 'blocked') {
        throw new SkillInvocationBlockedError(result.skillInvocation);
      }
      const started = result.turn;
      const skillInvocation =
        result.skillInvocation.loaded.length > 0 || result.skillInvocation.failed.length > 0
          ? result.skillInvocation
          : undefined;
      return {
        sessionId,
        turnId,
        runId: started.runId,
        events,
        summary: projectSessionCatalogSummary(configuration.session),
        ...(skillInvocation ? { skillInvocation } : {}),
      };
    } catch (error) {
      channel.failTurn(turnId, error);
      throw error;
    }
  }

  async *compactSession(): AsyncIterable<SessionEvent> {
    const sessionId = this.#requireSession('compact');
    const channel = await this.#ensureChannel(sessionId);
    const turnId = this.#newId();
    this.#claimedTurnIds.add(turnId);
    const events = channel.eventsForTurn(turnId);
    try {
      await this.#request('context.compact', { sessionId, turnId });
    } catch (error) {
      channel.failTurn(turnId, error);
      throw error;
    }
    yield* events;
  }

  async *resumeLatest(): AsyncIterable<SessionEvent> {
    const sessionId = this.#requireSession('resume');
    const plan = await this.#request('turn.resume.query', { sessionId });
    if (plan.disposition !== 'ready') {
      throw new Error(`Safe-boundary resume parked: ${plan.reason}`);
    }
    const channel = await this.#ensureChannel(sessionId);
    const turnId = this.#newId();
    this.#claimedTurnIds.add(turnId);
    const events = channel.eventsForTurn(turnId);
    try {
      const result = await this.#request('turn.resume.start', {
        sessionId,
        turnId,
        sourceRunId: plan.sourceRunId,
        sourceRuntimeEventHighWater: plan.sourceRuntimeEventHighWater,
      });
      if (result.kind !== 'started') {
        channel.failTurn(turnId, new Error(`Safe-boundary resume parked: ${result.plan.reason}`));
      }
    } catch (error) {
      channel.failTurn(turnId, error);
      throw error;
    }
    yield* events;
  }

  async steer(text: string): Promise<QueueEnqueueOutcome> {
    return this.#enqueue(text, 'current_turn');
  }

  async queueMessage(text: string): Promise<QueueEnqueueOutcome> {
    return this.#enqueue(text, 'next_turn');
  }

  async takePendingFollowup(): Promise<string | null> {
    // Runtime Host owns the terminal transition and starts the queued follow-up
    // atomically. Returning its text here would make the TUI submit it twice.
    return null;
  }

  async retractQueued(): Promise<string> {
    if (!this.#sessionId) return '';
    const result = await this.#request('queue.retract', {
      originHostEpoch: this.#connection.hostEpoch,
      sessionId: this.#sessionId,
      retractId: this.#newId(),
    });
    return result.retracted.map((entry) => entry.content.text).join('\n\n');
  }

  async respondToSandboxBoundary(response: SandboxBoundaryResponse): Promise<void> {
    const sessionId = this.#requireSession('respond to permission');
    const pending = this.#channel?.pendingInteraction(response.requestId);
    const answered = await this.#request('interaction.answer', {
      sessionId,
      interactionId: response.requestId,
      answer: { kind: 'sandbox_boundary', decision: response.decision },
    });
    if (pending) this.#channel?.publishInteractionAnswer(answered, pending);
  }

  async respondToUserQuestion(response: UserQuestionResponse): Promise<void> {
    const sessionId = this.#requireSession('respond to a user question');
    const pending = this.#channel?.pendingInteraction(response.requestId);
    const answered = await this.#request('interaction.answer', {
      sessionId,
      interactionId: response.requestId,
      answer: { kind: 'question', answers: response.answers },
    });
    if (pending) this.#channel?.publishInteractionAnswer(answered, pending);
  }

  async setModel(model: string, connectionSlug?: string): Promise<void> {
    const nextConnection = connectionSlug ?? this.#llmConnectionSlug;
    if (this.#sessionId) {
      const session = await this.#updateConfiguration(this.#sessionId, {
        modelTarget: { kind: 'explicit', connectionSlug: nextConnection, model },
        thinkingLevel: null,
      });
      this.#adoptConfiguration(session);
      return;
    }
    this.#model = model;
    this.#llmConnectionSlug = nextConnection;
    this.#thinkingLevel = undefined;
  }

  async setThinkingLevel(level: ThinkingLevel | undefined): Promise<void> {
    if (this.#sessionId) {
      this.#adoptConfiguration(
        await this.#updateConfiguration(this.#sessionId, { thinkingLevel: level ?? null }),
      );
      return;
    }
    this.#thinkingLevel = level;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.#sessionId) {
      const session = await this.#updateConfiguration(this.#sessionId, { permissionMode: mode });
      this.#permissionMode = session.permissionMode;
      const boundary = await this.#request('session.execution_boundary.query', {
        sessionId: this.#sessionId,
      });
      this.#activeBoundaryDisplayMode = executionBoundaryDisplayMode(boundary);
      return;
    }
    this.#permissionMode = mode;
  }

  async setOrchestrationMode(mode: OrchestrationMode): Promise<void> {
    if (this.#sessionId) {
      this.#adoptConfiguration(
        await this.#updateConfiguration(this.#sessionId, { orchestrationMode: mode }),
      );
      return;
    }
    this.#orchestrationMode = mode;
  }

  async renameSession(name: string): Promise<string> {
    const sessionId = this.#requireSession('rename');
    const session = await updateRuntimeHostSession(this.#connection, sessionId, (current) =>
      this.#request('session.metadata.update', {
        sessionId,
        expectedRevision: current.revision,
        patch: { name },
      }),
    );
    return session.name;
  }

  async #moveSession(rawCwd: string): Promise<MakaSessionMoveResult> {
    const sessionId = this.#requireSession('move');
    const nextCwd = await resolveMoveCwd(rawCwd, this.#workspace.hostCwd);
    const previousCwd = this.#workspace.hostCwd;
    if (nextCwd === previousCwd) {
      return { previousCwd, cwd: nextCwd, changed: false, oldCwdDirty: false };
    }
    const oldCwdDirty = await this.#inspectCwdChanges(previousCwd).catch(() => undefined);
    const session = await this.#commitCwdRelocation(sessionId, nextCwd);
    this.#workspace = session.workspace;
    return { previousCwd, cwd: this.#workspace.hostCwd, changed: true, oldCwdDirty };
  }

  async switchSession(
    sessionId: string,
    options: MakaSessionSwitchOptions = {},
  ): Promise<MakaSessionSwitchResult> {
    if (options.relocateCwd !== undefined && this.#executionLocation.kind === 'host') {
      throw new Error('A remote Runtime Host Session cannot be relocated by this Client');
    }
    let session = await getRuntimeHostSession(this.#connection, sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    let summary = projectSessionCatalogSummary(session);
    if (options.relocateCwd === undefined) {
      await assertSessionResumeAvailable(summary, this.#executionLocation);
    }
    const boundary = await this.#request('session.execution_boundary.query', { sessionId });
    if (boundary.kind === 'external') {
      throw new Error(
        `Cannot resume externally isolated session ${sessionId} outside its owning harness.`,
      );
    }
    let relocation: MakaSessionMoveResult | undefined;
    if (options.relocateCwd !== undefined) {
      const nextCwd = await resolveMoveCwd(options.relocateCwd, this.#workspace.hostCwd);
      const previousCwd = session.workspace.hostCwd;
      if (nextCwd === previousCwd) {
        relocation = { previousCwd, cwd: nextCwd, changed: false, oldCwdDirty: false };
      } else {
        const oldCwdDirty = await this.#inspectCwdChanges(previousCwd).catch(() => undefined);
        session = await this.#commitCwdRelocation(sessionId, nextCwd);
        relocation = {
          previousCwd,
          cwd: session.workspace.hostCwd,
          changed: true,
          oldCwdDirty,
        };
      }
      summary = projectSessionCatalogSummary(session);
      await assertSessionResumeAvailable(summary, this.#executionLocation);
    }
    const expectedChannelGeneration = this.#channelGeneration;
    const nextSessionGeneration = this.#sessionGeneration + 1;
    const opened = await this.#openSessionChannel(sessionId, nextSessionGeneration);
    if (this.#channelGeneration !== expectedChannelGeneration) {
      await opened.channel.close().catch(() => undefined);
      throw new Error(`Session changed while opening Runtime Host channel: ${sessionId}`);
    }
    this.#sessionGeneration = nextSessionGeneration;
    this.#channelGeneration += 1;
    this.#sessionId = sessionId;
    await this.#replaceChannel(opened.channel);
    this.#workspace = session.workspace;
    this.#adoptConfiguration(session);
    this.#hiddenTranscriptThroughTurnId = isSideConversationSession(session.labels)
      ? session.branchOfTurnId
      : undefined;
    this.#activeBoundaryDisplayMode = executionBoundaryDisplayMode(boundary);
    const attachedTurnId = opened.attachedTurnId ?? opened.channel.firstObservedTurnId;
    opened.channel.activate(attachedTurnId);
    return {
      summary,
      messages: visibleTranscriptMessages(opened.messages, this.#hiddenTranscriptThroughTurnId),
      ...(relocation === undefined ? {} : { relocation }),
      ...(attachedTurnId
        ? {
            activeTurn: {
              sessionId,
              turnId: attachedTurnId,
              ...(opened.channel.snapshot.rootTurn?.turnId === attachedTurnId
                ? { runId: opened.channel.snapshot.rootTurn.runId }
                : {}),
              events: opened.channel.eventsForTurn(attachedTurnId),
            },
          }
        : {}),
    };
  }

  #commitCwdRelocation(sessionId: string, cwd: string): Promise<SessionCatalogProjection> {
    return updateRuntimeHostSession(this.#connection, sessionId, (current) =>
      this.#request('session.workspace.relocate', {
        sessionId,
        expectedRevision: current.revision,
        workspace: { kind: 'host_path', path: cwd },
      }),
    );
  }

  async listRewindTargets(): Promise<RewindTarget[]> {
    if (!this.#sessionId) return [];
    const messages = await this.readMessages();
    const seenTurnIds = new Set<string>();
    const targets: RewindTarget[] = [];
    for (const message of messages) {
      if (message.type !== 'user' || seenTurnIds.has(message.turnId)) continue;
      seenTurnIds.add(message.turnId);
      if (message.origin) continue;
      targets.push({ turnId: message.turnId, label: firstLine(userFacingText(message)) });
    }
    return targets.reverse();
  }

  async rewindToTurn(turnId: string): Promise<MakaSessionRewindResult> {
    const sourceSessionId = this.#requireSession('rewind');
    const messages = await this.readMessages();
    const promptMessage = messages.find(
      (message): message is Extract<StoredMessage, { type: 'user' }> =>
        message.type === 'user' && message.turnId === turnId,
    );
    if (!promptMessage) throw new Error(`Cannot rewind to turn ${turnId}: no user prompt.`);
    if (promptMessage.origin) {
      throw new Error(`Cannot rewind to turn ${turnId}: Host-triggered prompts are read-only.`);
    }
    const targetSessionId = this.#newId();
    for (let attempt = 0; attempt < MAX_CATALOG_ATTEMPTS; attempt += 1) {
      const current = await getRuntimeHostSession(this.#connection, sourceSessionId);
      if (!current) throw new Error(`Session not found: ${sourceSessionId}`);
      const result = await this.#request('session.revision.create', {
        sourceSessionId,
        targetSessionId,
        sourceTurnId: turnId,
        expectedSourceRevision: current.revision,
      });
      if (result.kind === 'committed') {
        return {
          ...(await this.switchSession(requireSession(result.session).id)),
          prompt: userFacingText(promptMessage),
        };
      }
    }
    throw new Error(`Session kept changing while rewinding: ${sourceSessionId}`);
  }

  async recoverSideConversations(): Promise<void> {
    await this.#requireSessionCopyCleanup().recover();
  }

  async openSideConversation(): Promise<MakaSideConversationOpenResult> {
    const parentSessionId = this.#requireSession('open a side conversation');
    const messages = await loadCurrentMessages(this.#connection, parentSessionId);
    const sourceTurnId = deriveTurnRecords(messages)
      .reverse()
      .find((turn) => turn.status === 'completed')?.turnId;
    if (!sourceTurnId) {
      throw new Error('A side conversation requires at least one completed Turn.');
    }
    const sideSessionId = this.#newId();
    const cleanup = this.#requireSessionCopyCleanup();
    await cleanup.ownCreation(
      {
        sessionId: sideSessionId,
        kind: 'branch',
        sourceSessionId: parentSessionId,
        sourceTurnId,
        intent: 'side_conversation',
        ownerId: 'tui-side',
      },
      () =>
        this.#resumeSessionCopy({
          sessionId: sideSessionId,
          kind: 'branch',
          sourceSessionId: parentSessionId,
          sourceTurnId,
          intent: 'side_conversation',
        }),
    );
    try {
      return {
        ...(await this.switchSession(sideSessionId)),
        parentSessionId,
        sideSessionId,
      };
    } catch (error) {
      await cleanup.schedule(sideSessionId).catch(() => undefined);
      throw error;
    }
  }

  async closeSideConversation(
    sideSessionId: string,
    parentSessionId: string,
  ): Promise<MakaSideConversationCloseResult> {
    if (this.#sessionId !== sideSessionId) {
      throw new Error('The active Session is not the side conversation being closed.');
    }
    const parent = await this.switchSession(parentSessionId);
    const cleanup = await this.#requireSessionCopyCleanup()
      .cleanup(sideSessionId)
      .then(() => 'removed' as const)
      .catch(() => 'pending' as const);
    return { ...parent, cleanup };
  }

  async cleanupOwnedSideConversations(): Promise<void> {
    await this.#requireSessionCopyCleanup().abandonOwner('tui-side');
  }

  startNewSession(): void {
    this.#sessionGeneration += 1;
    this.#channelGeneration += 1;
    this.#sessionId = null;
    this.#hiddenTranscriptThroughTurnId = undefined;
    // A fresh Session carries no client claim on its mode: leaving a previous
    // Session's elevation here would both misreport the mode and create the
    // next Session with it (#3020). Full access stays an explicit per-session
    // opt-in; `setPermissionMode` can still raise it before the first prompt
    // creates the Session.
    this.#permissionMode = undefined;
    this.#activeBoundaryDisplayMode = undefined;
    void this.#refreshProspectivePermissionMode();
    void this.#replaceChannel(undefined);
  }

  subscribeStartedTurns(listener: (turn: MakaAttachedSessionTurn) => void): () => void {
    this.#startedTurnListeners.add(listener);
    return () => this.#startedTurnListeners.delete(listener);
  }

  subscribePendingInteractions(
    listener: (pending: InteractionPendingSnapshot) => void,
  ): () => void {
    this.#pendingInteractionListeners.add(listener);
    return () => this.#pendingInteractionListeners.delete(listener);
  }

  subscribeResolvedInteractions(
    listener: (sessionId: string, requestId: string) => void,
  ): () => void {
    this.#resolvedInteractionListeners.add(listener);
    return () => this.#resolvedInteractionListeners.delete(listener);
  }

  subscribeTranscriptReplacements(
    listener: (
      sessionId: string,
      turnId: string,
      messages: readonly StoredMessage[],
      reason: MakaTranscriptReplacementReason,
    ) => void,
  ): () => void {
    this.#transcriptListeners.add(listener);
    return () => this.#transcriptListeners.delete(listener);
  }

  listShellRunUpdates(sessionId: string): Promise<ShellRunUpdate[]> {
    return readRuntimeHostResources(this.#connection, sessionId);
  }

  subscribeShellRunUpdates(listener: (update: ShellRunUpdate) => void): () => void {
    this.#shellRunListeners.add(listener);
    return () => this.#shellRunListeners.delete(listener);
  }

  async stop(): Promise<void> {
    const turn = this.#channel?.snapshot.rootTurn;
    if (!turn || isTerminalTurn(turn)) return;
    await this.#request('turn.stop', {
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      runId: turn.runId,
    });
  }

  getSessionId(): string | null {
    return this.#sessionId;
  }

  getGoal(): GoalProjection | null {
    // The session subscription's continuity snapshot carries the goal
    // projection and is folded on every pushed frame, so this read is as
    // fresh as the host's last broadcast — no RPC, no staleness window.
    return this.#channel?.snapshot.goal ?? null;
  }

  subscribeGoalChanges(listener: (goal: GoalProjection | null) => void): () => void {
    this.#goalListeners.add(listener);
    return () => this.#goalListeners.delete(listener);
  }

  async controlGoal(action: GoalControlAction): Promise<GoalProjection | null> {
    const sessionId = this.#sessionId;
    if (!sessionId) return null;
    let goal = this.getGoal();
    if (!goal) return null;
    // Optimistic concurrency with the same shape as the desktop client's
    // clearGoal: expectedRevision guards against a concurrent controller, and
    // an operation_conflict retries against a freshly queried projection —
    // the pushed snapshot may lag the conflicting mutation by a frame.
    const goalId = goal.goalId;
    for (let attempt = 0; attempt < GOAL_CONTROL_MAX_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.#request('goal.control', {
          sessionId,
          goalId,
          expectedRevision: goal.revision,
          action,
        });
        return result.goal;
      } catch (error) {
        if (!(error instanceof RuntimeHostOperationError) || error.code !== 'operation_conflict') {
          throw error;
        }
        if (attempt === GOAL_CONTROL_MAX_ATTEMPTS - 1) throw error;
        const current = (await this.#request('goal.query', { sessionId })).goal;
        if (!current || current.goalId !== goalId) return null;
        if (current.revision === goal.revision) {
          // The host folds invalid transitions into operation_conflict too
          // ("Goal cannot pause from status paused"). Every accepted transition
          // bumps the revision, so a conflict at an unchanged revision is a
          // status refusal, not a race — retrying is futile. Surface the host's
          // reason instead of a misleading "revision conflict" exhaustion error.
          throw error;
        }
        goal = current;
      }
    }
    throw new Error(`Goal ${action} failed without a result`);
  }

  async getContextDiagnostics(): Promise<ContextDiagnostics> {
    if (!this.#sessionId) return { status: 'unavailable', reason: 'no_completed_request' };
    const diagnostics = await this.#request('context.diagnostics.query', {
      sessionId: this.#sessionId,
    });
    if (diagnostics.status === 'unavailable') return diagnostics;
    // The protocol frame is readonly; the CLI's own type is not. Copied field
    // by field rather than spread so a future protocol field cannot arrive
    // here unnoticed.
    const { composition, compaction, ...rest } = diagnostics;
    return {
      ...rest,
      ...(composition
        ? {
            composition: {
              segments: composition.segments.map((segment) => ({ ...segment })),
              ...(composition.tools
                ? { tools: composition.tools.map((tool) => ({ ...tool })) }
                : {}),
              ...(composition.remainingTools
                ? { remainingTools: { ...composition.remainingTools } }
                : {}),
              ...(composition.unlabelledToolBytes !== undefined
                ? { unlabelledToolBytes: composition.unlabelledToolBytes }
                : {}),
            },
          }
        : {}),
      ...(compaction ? { compaction: { ...compaction } } : {}),
    };
  }

  getOrchestrationMode(): OrchestrationMode {
    return this.#orchestrationMode;
  }

  getPermissionMode(): PermissionMode | undefined {
    return (
      this.#activeBoundaryDisplayMode ?? this.#permissionMode ?? this.#prospectivePermissionMode
    );
  }

  /**
   * Re-read the Host's chat default after the Session it described is gone.
   *
   * Best effort on purpose: this only moves a label, and creation omits the
   * field either way, so a failed refresh keeps the last authoritative reading
   * rather than inventing one.
   */
  async #refreshProspectivePermissionMode(): Promise<void> {
    try {
      const policy = await this.#request('runtime.policy.query', {});
      this.#prospectivePermissionMode = policy.policy.chatDefaults.permissionMode;
    } catch {
      // Keep the previous reading.
    }
  }

  async #ensureSession(): Promise<string> {
    if (this.#sessionId) return this.#sessionId;
    return (await this.#createSession(DEFAULT_SESSION_NAME)).id;
  }

  async #createSession(name: string): Promise<SessionCatalogProjection> {
    const workspace = this.#workspace.target;
    if (!workspace) {
      throw new Error('A remote Runtime Host Session requires an explicit Project');
    }
    const sessionId = this.#newId();
    const session = requireSession(
      await this.#request('session.create', {
        sessionId,
        workspace,
        name,
        modelTarget: {
          kind: 'explicit',
          connectionSlug: this.#llmConnectionSlug,
          model: this.#model,
        },
        ...(this.#permissionMode === undefined ? {} : { permissionMode: this.#permissionMode }),
        ...(this.#orchestrationMode === 'default'
          ? {}
          : { orchestrationMode: this.#orchestrationMode }),
        ...(this.#thinkingLevel === undefined ? {} : { thinkingLevel: this.#thinkingLevel }),
      }),
    );
    this.#sessionGeneration += 1;
    this.#sessionId = sessionId;
    this.#workspace = session.workspace;
    this.#adoptConfiguration(session);
    await this.#ensureChannel(sessionId);
    return session;
  }

  async #ensureChannel(sessionId: string): Promise<RuntimeHostSessionChannel> {
    if (this.#channel?.sessionId === sessionId && !this.#channel.failed) return this.#channel;
    if (this.#channelOpening?.sessionId === sessionId) return this.#channelOpening.promise;
    const promise = this.#openChannel(sessionId);
    this.#channelOpening = { sessionId, promise };
    try {
      return await promise;
    } finally {
      if (this.#channelOpening?.promise === promise) this.#channelOpening = undefined;
    }
  }

  async #openChannel(sessionId: string): Promise<RuntimeHostSessionChannel> {
    const sessionGeneration = this.#sessionGeneration;
    const expectedChannelGeneration = this.#channelGeneration;
    const opened = await this.#openSessionChannel(sessionId, sessionGeneration);
    if (
      this.#sessionId !== sessionId ||
      this.#sessionGeneration !== sessionGeneration ||
      this.#channelGeneration !== expectedChannelGeneration
    ) {
      await opened.channel.close().catch(() => undefined);
      throw new Error(`Session changed while opening Runtime Host channel: ${sessionId}`);
    }
    this.#channelGeneration += 1;
    await this.#replaceChannel(opened.channel);
    opened.channel.activate();
    return opened.channel;
  }

  async #replaceChannel(next: RuntimeHostSessionChannel | undefined): Promise<void> {
    const previous = this.#channel;
    this.#channel = next;
    const goal = next?.snapshot.goal ?? null;
    for (const listener of this.#goalListeners) listener(goal);
    await previous?.close().catch(() => undefined);
  }

  async #enqueue(
    text: string,
    placement: 'current_turn' | 'next_turn',
  ): Promise<QueueEnqueueOutcome> {
    const sessionId = this.#sessionId;
    if (!sessionId) return { kind: 'fallback' };
    const result = await this.#request('turn.message.submit', {
      originHostEpoch: this.#connection.hostEpoch,
      sessionId,
      messageId: this.#newId(),
      content: { text },
      placement,
    });
    // A root Turn can settle between the local projection check and Host
    // admission. The Host has already started the message in that case, so it
    // must not be submitted again. Treat it as accepted; the subscription owns
    // projection of the successor Turn.
    return { kind: 'queued' };
  }

  async #updateConfiguration(
    sessionId: string,
    patch: {
      modelTarget?: { kind: 'explicit'; connectionSlug: string; model: string };
      thinkingLevel?: ThinkingLevel | null;
      permissionMode?: PermissionMode;
      orchestrationMode?: OrchestrationMode;
    },
  ): Promise<SessionCatalogProjection> {
    return updateRuntimeHostSession(this.#connection, sessionId, (current) =>
      this.#request('session.configuration.update', {
        sessionId,
        expectedRevision: current.revision,
        configuration: {
          modelTarget:
            patch.modelTarget ??
            (current.connectionLocked
              ? {
                  kind: 'explicit',
                  connectionSlug: current.llmConnectionSlug,
                  model: current.model,
                }
              : { kind: 'default' }),
          thinkingLevel:
            patch.thinkingLevel === undefined
              ? (current.thinkingLevel ?? null)
              : patch.thinkingLevel,
          permissionMode: patch.permissionMode ?? current.permissionMode,
          collaborationMode: current.collaborationMode,
          orchestrationMode: patch.orchestrationMode ?? current.orchestrationMode,
        },
      }),
    );
  }

  #adoptConfiguration(session: SessionCatalogProjection): void {
    this.#model = session.model;
    this.#llmConnectionSlug = session.llmConnectionSlug;
    this.#thinkingLevel = session.thinkingLevel;
    this.#permissionMode = session.permissionMode;
    this.#orchestrationMode = session.orchestrationMode;
  }

  async #loadConfiguration(sessionId: string): Promise<LoadedSessionConfiguration> {
    const [session, boundary] = await Promise.all([
      getRuntimeHostSession(this.#connection, sessionId),
      this.#request('session.execution_boundary.query', { sessionId }),
    ]);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return {
      session,
      boundaryDisplayMode:
        boundary.kind === 'external' ? undefined : executionBoundaryDisplayMode(boundary),
    };
  }

  #adoptLoadedConfiguration(configuration: LoadedSessionConfiguration): void {
    this.#adoptConfiguration(configuration.session);
    this.#activeBoundaryDisplayMode = configuration.boundaryDisplayMode;
  }

  #assertCurrentSession(sessionId: string, sessionGeneration: number): void {
    if (this.#sessionId !== sessionId || this.#sessionGeneration !== sessionGeneration) {
      throw new Error(`Session changed while loading Runtime Host state: ${sessionId}`);
    }
  }

  #requireSession(action: string): string {
    if (!this.#sessionId) throw new Error(`Cannot ${action} before a session starts.`);
    return this.#sessionId;
  }

  #requireSessionCopyCleanup(): SessionCopyCleanupAuthority {
    if (!this.#sessionCopyCleanup) {
      throw new Error('Side conversations are unavailable without durable cleanup storage.');
    }
    return this.#sessionCopyCleanup;
  }

  async #resumeSessionCopy(input: {
    sessionId: string;
    kind: 'branch' | 'revision';
    sourceSessionId: string;
    sourceTurnId: string;
    intent?: 'side_conversation';
  }): Promise<void> {
    if (input.kind !== 'branch') {
      throw new Error(`TUI side cleanup cannot resume a ${input.kind} copy.`);
    }
    for (let attempt = 0; attempt < MAX_CATALOG_ATTEMPTS; attempt += 1) {
      const source = await getRuntimeHostSession(this.#connection, input.sourceSessionId);
      if (!source) throw new Error(`Session not found: ${input.sourceSessionId}`);
      const result = await this.#request('session.branch.create', {
        sourceSessionId: input.sourceSessionId,
        targetSessionId: input.sessionId,
        sourceTurnId: input.sourceTurnId,
        expectedSourceRevision: source.revision,
        ...(input.intent ? { intent: input.intent } : {}),
      });
      if (result.kind === 'committed') return;
    }
    throw new Error(`Session kept changing while copying: ${input.sourceSessionId}`);
  }

  async #removeSessionCopy(sessionId: string): Promise<'removed'> {
    for (let attempt = 0; attempt < MAX_CATALOG_ATTEMPTS; attempt += 1) {
      const session = await getRuntimeHostSession(this.#connection, sessionId);
      if (!session) return 'removed';
      const result = await this.#request('session.remove', {
        sessionId,
        expectedRevision: session.revision,
      });
      if (result.kind === 'removed') return 'removed';
    }
    throw new Error(`Session kept changing while removing: ${sessionId}`);
  }

  #publishStartedTurn(turn: MakaPreparedSessionTurn, sessionGeneration: number): void {
    if (this.#claimedTurnIds.delete(turn.turnId)) return;
    const sourceChannel = this.#channel;
    const tail = this.#startedTurnReattachTails.get(sessionGeneration) ?? Promise.resolve();
    const attempt = tail.then(() =>
      this.#reattachStartedTurn(sessionGeneration, turn.sessionId, turn.turnId),
    );
    const settled = attempt.catch(() => undefined);
    this.#startedTurnReattachTails.set(sessionGeneration, settled);
    void settled.then(() => {
      if (this.#startedTurnReattachTails.get(sessionGeneration) === settled) {
        this.#startedTurnReattachTails.delete(sessionGeneration);
      }
    });
    void attempt.catch((error) => sourceChannel?.failTurn(turn.turnId, error));
  }

  async #reattachStartedTurn(
    sessionGeneration: number,
    sessionId: string,
    turnId: string,
  ): Promise<void> {
    if (this.#sessionId !== sessionId || this.#sessionGeneration !== sessionGeneration) return;
    const expectedChannelGeneration = this.#channelGeneration;
    const opened = await this.#openSessionChannel(sessionId, sessionGeneration);
    if (
      this.#sessionId !== sessionId ||
      this.#sessionGeneration !== sessionGeneration ||
      this.#channelGeneration !== expectedChannelGeneration
    ) {
      await opened.channel.close().catch(() => undefined);
      return;
    }
    if (opened.attachedTurnId !== turnId) {
      if (opened.terminalTurn?.turnId !== turnId) {
        await opened.channel.close().catch(() => undefined);
        return;
      }
      opened.channel.seedTerminalCut(opened.terminalTurn);
    }
    let configuration: LoadedSessionConfiguration;
    try {
      configuration = await this.#loadConfiguration(sessionId);
    } catch {
      await opened.channel.close().catch(() => undefined);
      return;
    }
    if (
      this.#sessionId !== sessionId ||
      this.#sessionGeneration !== sessionGeneration ||
      this.#channelGeneration !== expectedChannelGeneration
    ) {
      await opened.channel.close().catch(() => undefined);
      return;
    }
    this.#adoptLoadedConfiguration(configuration);
    this.#channelGeneration += 1;
    await this.#replaceChannel(opened.channel);
    const turn = {
      sessionId,
      turnId,
      ...(opened.channel.snapshot.rootTurn?.turnId === turnId
        ? { runId: opened.channel.snapshot.rootTurn.runId }
        : {}),
      events: opened.channel.eventsForTurn(turnId),
      messages: opened.messages,
      summary: projectSessionCatalogSummary(configuration.session),
    } satisfies MakaAttachedSessionTurn;
    for (const listener of this.#startedTurnListeners) listener(turn);
    opened.channel.activate(turnId);
  }

  #openSessionChannel(
    sessionId: string,
    sessionGeneration: number,
  ): Promise<RuntimeHostSessionChannelOpenResult> {
    return RuntimeHostSessionChannel.open({
      connection: this.#connection,
      sessionId,
      now: this.#now,
      onTurnStarted: (turn) => this.#publishStartedTurn(turn, sessionGeneration),
      onRuntimeResourceChanged: (sourceSessionId, ref) =>
        this.#publishRuntimeResource(sourceSessionId, ref),
      onInteractionPending: (pending) => {
        for (const listener of this.#pendingInteractionListeners) listener(pending);
      },
      onInteractionResolved: (pending) => this.#resolveExternalInteraction(pending),
      onTranscriptSettlement: (turnId) =>
        this.#refreshTranscript(sessionId, sessionGeneration, turnId),
      onTranscriptReplaced: (turnId, messages) =>
        this.#publishTranscriptReplacement(
          sessionId,
          sessionGeneration,
          turnId,
          messages,
          'reconnect',
        ),
      onGoalChanged: (goal) => {
        // A closing channel from a previous session can still be draining a
        // frame when the swap happens; only the live session may publish.
        if (this.#sessionId !== sessionId || this.#sessionGeneration !== sessionGeneration) return;
        for (const listener of this.#goalListeners) listener(goal);
      },
      onRecovered: () => this.#refreshRuntimeResources(sessionId),
    });
  }

  #publishRuntimeResource(sourceSessionId: string, ref: string): void {
    void this.#request('runtime.resource.query', {
      kind: 'get',
      sessionId: sourceSessionId,
      ref,
    })
      .then((result) => {
        if (result.kind !== 'resource' || !result.resource) return;
        for (const listener of this.#shellRunListeners) listener(result.resource);
      })
      .catch(() => undefined);
  }

  #resolveExternalInteraction(pending: InteractionPendingSnapshot): void {
    void this.#request('interaction.query', {
      sessionId: pending.sessionId,
      interactionId: pending.interactionId,
    })
      .then((resolved) => {
        if (resolved.status === 'answered') {
          this.#channel?.publishInteractionAnswer(resolved, pending);
        }
        if (resolved.status === 'pending') return;
        for (const listener of this.#resolvedInteractionListeners) {
          listener(pending.sessionId, pending.interactionId);
        }
      })
      .catch(() => undefined);
  }

  #refreshTranscript(sessionId: string, sessionGeneration: number, turnId: string): void {
    const refreshSequence = ++this.#transcriptRefreshSequence;
    const hiddenThroughTurnId = this.#hiddenTranscriptThroughTurnId;
    void loadCurrentMessages(this.#connection, sessionId)
      .then((messages) => {
        if (
          this.#sessionId !== sessionId ||
          this.#sessionGeneration !== sessionGeneration ||
          refreshSequence !== this.#transcriptRefreshSequence
        ) {
          return;
        }
        this.#publishTranscriptReplacement(
          sessionId,
          sessionGeneration,
          turnId,
          visibleTranscriptMessages(messages, hiddenThroughTurnId),
          'reconcile',
        );
      })
      .catch(() => undefined);
  }

  #publishTranscriptReplacement(
    sessionId: string,
    sessionGeneration: number,
    turnId: string,
    messages: readonly StoredMessage[],
    reason: MakaTranscriptReplacementReason,
  ): void {
    if (this.#sessionId !== sessionId || this.#sessionGeneration !== sessionGeneration) return;
    this.#transcriptRefreshSequence += 1;
    for (const listener of this.#transcriptListeners) {
      listener(sessionId, turnId, messages, reason);
    }
  }

  #refreshRuntimeResources(sessionId: string): void {
    void readRuntimeHostResources(this.#connection, sessionId)
      .then((resources) => {
        if (this.#sessionId !== sessionId) return;
        for (const resource of resources) {
          for (const listener of this.#shellRunListeners) listener(resource);
        }
      })
      .catch(() => undefined);
  }

  #request<K extends DirectRequestOperationKey>(
    operation: K,
    input: OperationInput<K>,
  ): Promise<OperationOutput<K>> {
    return this.#connection.request(operation, input);
  }
}

function workspaceTargetForCreate(
  current: { readonly target?: WorkspaceTarget; readonly hostCwd: string },
  input: Pick<CreateSessionInput, 'cwd' | 'projectId'>,
  location: NonNullable<RuntimeHostMakaSessionDriverInput['executionLocation']>,
): WorkspaceTarget {
  if (typeof input.projectId === 'string') {
    return { kind: 'project', projectId: input.projectId };
  }
  if (location.kind === 'host') {
    if (current.target) return current.target;
    throw new Error('A remote Runtime Host Session requires an explicit Project');
  }
  if (input.projectId === null || input.cwd !== current.hostCwd) {
    return { kind: 'host_path', path: input.cwd };
  }
  return current.target!;
}

interface LoadedSessionConfiguration {
  session: SessionCatalogProjection;
  boundaryDisplayMode: PermissionMode | undefined;
}

async function getRuntimeHostSession(
  connection: RuntimeHostSessionDriverConnection,
  sessionId: string,
): Promise<SessionCatalogProjection | null> {
  const result = await connection.request('session.catalog.query', { kind: 'get', sessionId });
  if (result.kind !== 'session') throw new Error('Runtime Host returned an invalid Session lookup');
  return result.session === null ? null : requireSession(result.session);
}

function representableSession(item: SessionCatalogItem): SessionCatalogProjection[] {
  return 'kind' in item ? [] : [item];
}

function isTuiProcessActive(ownerProcessId: string): boolean {
  const match = /^tui:(\d+)$/.exec(ownerProcessId);
  if (!match) return false;
  const processId = Number(match[1]);
  if (!Number.isSafeInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function visibleTranscriptMessages(
  messages: StoredMessage[],
  hiddenThroughTurnId: string | undefined,
): StoredMessage[] {
  if (!hiddenThroughTurnId) return messages;
  let boundary = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if ('turnId' in messages[index]! && messages[index]!.turnId === hiddenThroughTurnId) {
      boundary = index;
    }
  }
  return boundary < 0 ? messages : messages.slice(boundary + 1);
}

function requireSession(item: SessionCatalogItem): SessionCatalogProjection {
  if (!('kind' in item)) return item;
  throw new Error(`Runtime Host Session is not representable by this CLI: ${item.id}`);
}

function inspectRuntimeHostSessionResumeAvailability(
  summary: SessionSummary,
  location: NonNullable<RuntimeHostMakaSessionDriverInput['executionLocation']>,
): Promise<SessionResumeAvailability> {
  if (!summary.cwd) {
    return Promise.resolve({ available: false, reason: 'Missing working directory' });
  }
  return location.kind === 'host'
    ? Promise.resolve({ available: true })
    : inspectSessionResumeAvailability(summary);
}

async function assertSessionResumeAvailable(
  summary: SessionSummary,
  location: NonNullable<RuntimeHostMakaSessionDriverInput['executionLocation']>,
): Promise<void> {
  const availability = await inspectRuntimeHostSessionResumeAvailability(summary, location);
  if (!availability.available) {
    throw new Error(
      summary.cwd ? `Session cwd no longer exists: ${summary.cwd}` : availability.reason,
    );
  }
}

async function updateRuntimeHostSession(
  connection: RuntimeHostSessionDriverConnection,
  sessionId: string,
  update: (current: SessionCatalogProjection) => Promise<SessionUpdateResult>,
): Promise<SessionCatalogProjection> {
  for (let attempt = 0; attempt < MAX_CATALOG_ATTEMPTS; attempt += 1) {
    const current = await getRuntimeHostSession(connection, sessionId);
    if (!current) throw new Error(`Session not found: ${sessionId}`);
    const result = await update(current);
    if (result.kind === 'committed') return requireSession(result.session);
  }
  throw new Error(`Session kept changing while updating: ${sessionId}`);
}

async function loadCurrentMessages(
  connection: RuntimeHostSessionDriverConnection,
  sessionId: string,
): Promise<StoredMessage[]> {
  const subscription = await connection.openSessionSubscription({
    sessionId,
    transcript: { kind: 'tail', maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES },
  });
  const draining = (async () => {
    for await (const _frame of subscription) {
      // The transcript is pinned to the subscription snapshot. Drain newer
      // frames only to preserve the bounded transport while the read runs.
    }
  })();
  try {
    return await subscription.loadTranscript(decodeStoredMessage);
  } finally {
    await subscription.close().catch(() => undefined);
    await draining.catch(() => undefined);
  }
}
