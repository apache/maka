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

import {
  deriveTurnRecords,
  type StoredMessage,
  type TurnRecord,
} from '@maka/core/session';
import type {
  DesktopTranscriptBatch,
  DesktopTranscriptHandle,
} from '../preload/transcript-contract.js';
import { parseDesktopSessionKey } from '../shared/runtime-host-identity.js';
import { DesktopTranscriptRangeStore } from './desktop-transcript-range-store.js';
import type {
  WorkHubProjectedTurn,
  WorkHubDelegationFeedback,
  WorkHubDelegationReference,
  WorkHubSessionFacts,
  WorkHubSessionPort,
  WorkHubSessionState,
  WorkHubSessionTarget,
} from './workhub-controller.js';
import { boundedWorkHubTimelineText } from './workhub-controller.js';

export interface WorkHubDesktopSession {
  id: string;
  name: string;
  labels: readonly string[];
  isArchived: boolean;
  status: 'active' | 'running' | 'waiting_for_user' | 'blocked' | 'aborted';
  runningTurnIds?: readonly string[];
  projectId?: string | null;
  cwd?: string;
  lastMessageAt?: number;
  lastMessagePreview?: string;
  statusUpdatedAt?: number;
  subagent?: object;
}

export interface WorkHubDesktopSessionBridge {
  list(): Promise<readonly WorkHubDesktopSession[]>;
  listWithCoverage?(): Promise<{
    sessions: readonly WorkHubDesktopSession[];
    completeHostIds: readonly string[];
  }>;
  listTurns(
    sessionId: string,
  ): Promise<readonly Partial<Pick<TurnRecord, 'turnId' | 'status' | 'statusSource' | 'userPromptPreview'>>[]>;
  queryMessageExecutions(
    sessionId: string,
    messageIds: readonly string[],
  ): Promise<{
    readonly resolutions: readonly (
      | { messageId: string; state: 'pending' }
      | { messageId: string; state: 'cancelled' }
      | { messageId: string; state: 'owned'; turnId: string; runId: string }
    )[];
  }>;
  subscribeChanges(handler: () => void): () => void;
}

export interface WorkHubDesktopTranscriptBridge {
  open(
    sessionId: string,
    handler: (batch: DesktopTranscriptBatch) => void,
    registerCancellation?: (cancel: () => void) => void,
  ): Promise<DesktopTranscriptHandle>;
}

const WORKHUB_TIMELINE_SESSION_LIMIT = 10;
const WORKHUB_TIMELINE_TURN_LIMIT = 40;
const WORKHUB_TRANSCRIPT_READY_TIMEOUT_MS = 5_000;

export function createDesktopWorkHubSessionPort<
  Sessions extends WorkHubDesktopSessionBridge,
>(deps: {
  sessions: Sessions;
  transcripts: WorkHubDesktopTranscriptBridge;
  projectName(projectId: string): string | undefined;
}): WorkHubSessionPort {
  // The first prompt is immutable Session-log evidence. This cache is only a
  // rebuildable read optimization; it is never an authority or a write path.
  const originPromptCache = new Map<string, string>();
  const project = (session: WorkHubDesktopSession): string => {
    if (session.projectId) {
      const name = deps.projectName(session.projectId);
      if (name) return name;
    }
    const normalizedCwd = session.cwd?.replace(/[/\\]+$/, '');
    return normalizedCwd?.split(/[/\\]/).at(-1) || 'Unassigned';
  };
  const projectSession = (session: WorkHubDesktopSession): WorkHubSessionFacts => ({
    target: { sessionId: session.id },
    projectName: project(session),
    sessionName: session.name,
    kind: session.subagent
      ? 'subagent'
      : session.labels.includes('mode:side_conversation')
        ? 'internal'
        : 'ordinary',
    archived: session.isArchived,
    state: projectState(session),
    ...(session.runningTurnIds !== undefined
      ? { runningTurnIds: [...session.runningTurnIds] }
      : {}),
    ...(session.lastMessagePreview
      ? { latestResult: session.lastMessagePreview }
      : {}),
    updatedAt: session.lastMessageAt ?? session.statusUpdatedAt ?? 0,
  });
  const projectCatalog = async () => {
    const snapshot = deps.sessions.listWithCoverage
      ? await deps.sessions.listWithCoverage()
      : { sessions: await deps.sessions.list(), completeHostIds: [] };
    const completeHostIds = new Set(snapshot.completeHostIds);
    return {
      sessions: snapshot.sessions.map(projectSession),
      isCompleteFor(target: WorkHubSessionTarget) {
        try {
          return completeHostIds.has(parseDesktopSessionKey(target.sessionId).hostId);
        } catch {
          return false;
        }
      },
    };
  };

  return {
    async list() {
      return (await projectCatalog()).sessions;
    },
    async recentTurns(targets) {
      const turnsBySession = await Promise.all(
        targets.slice(0, WORKHUB_TIMELINE_SESSION_LIMIT).map(async (target) => {
          try {
            const messages = await readWorkHubSessionMessages(deps.transcripts, target);
            return projectWorkHubSessionTurns({ target, messages });
          } catch {
            // One unavailable transcript must not hide the other Sessions or
            // turn WorkHub into a second recovery authority.
            return [];
          }
        }),
      );
      return turnsBySession
        .flat()
        .sort((left, right) =>
          left.updatedAt - right.updatedAt ||
          left.target.sessionId.localeCompare(right.target.sessionId) ||
          left.messageId.localeCompare(right.messageId),
        )
        .slice(-WORKHUB_TIMELINE_TURN_LIMIT);
    },
    async delegationFeedback(references) {
      let catalog: Awaited<ReturnType<typeof projectCatalog>> | undefined;
      try {
        catalog = await projectCatalog();
      } catch {
        // Exact Turn reads below may still recover terminal or running facts.
      }
      const sessionById = new Map(
        catalog?.sessions.map((session) => [session.target.sessionId, session]) ?? [],
      );
      const referencesBySessionId = new Map<string, WorkHubDelegationReference[]>();
      for (const reference of references) {
        const grouped = referencesBySessionId.get(reference.targetSessionId) ?? [];
        grouped.push(reference);
        referencesBySessionId.set(reference.targetSessionId, grouped);
      }
      const projected = await Promise.all(
        [...referencesBySessionId.entries()].map(async ([sessionId, grouped]) => {
          let turns: readonly Partial<
            Pick<TurnRecord, 'turnId' | 'status' | 'statusSource' | 'userPromptPreview'>
          >[] = [];
          let turnReadFailed = false;
          try {
            turns = await deps.sessions.listTurns(sessionId);
          } catch {
            turnReadFailed = true;
          }
          let executionReadFailed = false;
          let resolutions: readonly (
            | { messageId: string; state: 'pending' }
            | { messageId: string; state: 'cancelled' }
            | { messageId: string; state: 'owned'; turnId: string; runId: string }
          )[] = [];
          try {
            const result = await deps.sessions.queryMessageExecutions(
              sessionId,
              grouped.map(({ targetMessageId }) => targetMessageId),
            );
            resolutions = result.resolutions;
          } catch {
            executionReadFailed = true;
          }
          const turnById = new Map(
            turns.flatMap((turn) => turn.turnId ? [[turn.turnId, turn] as const] : []),
          );
          const resolutionByMessageId = new Map(
            resolutions.map((resolution) => [resolution.messageId, resolution]),
          );
          const session = sessionById.get(sessionId);
          return grouped.map((reference): WorkHubDelegationFeedback => {
            const resolution = resolutionByMessageId.get(reference.targetMessageId);
            const executionTurnId = resolution?.state === 'owned'
              ? resolution.turnId
              : undefined;
            return {
              delegationId: reference.delegationId,
              state: projectDelegationExecutionState({
                resolutionState: resolution?.state,
                executionTurnId,
                session,
                turn: executionTurnId ? turnById.get(executionTurnId) : undefined,
                turnReadFailed,
                executionReadFailed,
              }),
            };
          });
        }),
      );
      const feedbackByDelegationId = new Map(
        projected.flat().map((feedback) => [feedback.delegationId, feedback]),
      );
      return references.flatMap((reference) => {
        const feedback = feedbackByDelegationId.get(reference.delegationId);
        return feedback ? [feedback] : [];
      });
    },
    async routingEvidence(targets) {
      return Promise.all(targets.map(async (target) => {
        const cached = originPromptCache.get(target.sessionId);
        if (cached) return { target, originPrompt: cached };
        try {
          const turns = await deps.sessions.listTurns(target.sessionId);
          const originPrompt = turns
            .map((turn) => turn.userPromptPreview?.trim())
            .find((prompt): prompt is string => Boolean(prompt));
          if (originPrompt) originPromptCache.set(target.sessionId, originPrompt);
          return originPrompt ? { target, originPrompt } : { target };
        } catch {
          // A missing/unavailable transcript must not make the WorkHub surface
          // unusable; title and latest Session projection remain available.
          return { target };
        }
      }));
    },
    subscribe(handler) {
      return deps.sessions.subscribeChanges(handler);
    },
  };
}

export function projectWorkHubSessionTurns(input: {
  target: WorkHubSessionTarget;
  messages: readonly StoredMessage[];
}): WorkHubProjectedTurn[] {
  const stateByTurnId = new Map(
    deriveTurnRecords(input.messages).map((turn) => [turn.turnId, turn.status]),
  );
  const turns: WorkHubProjectedTurn[] = [];
  const latestUserIndexByTurnId = new Map<string, number>();

  for (const message of input.messages) {
    if (message.type === 'user') {
      const text = boundedWorkHubTimelineText(message.displayText ?? message.text);
      if (!text) continue;
      const state = stateByTurnId.get(message.turnId) ?? 'completed';
      turns.push({
        messageId: message.id,
        target: input.target,
        turnId: message.turnId,
        text,
        state,
        updatedAt: message.ts,
      });
      latestUserIndexByTurnId.set(message.turnId, turns.length - 1);
      continue;
    }
    if (message.type !== 'assistant') continue;
    const result = boundedWorkHubTimelineText(message.text);
    if (!result) continue;
    const userIndex = latestUserIndexByTurnId.get(message.turnId);
    if (userIndex === undefined) continue;
    turns[userIndex] = { ...turns[userIndex]!, result };
  }

  return turns;
}

async function readWorkHubSessionMessages(
  transcripts: WorkHubDesktopTranscriptBridge,
  target: WorkHubSessionTarget,
): Promise<readonly StoredMessage[]> {
  const store = new DesktopTranscriptRangeStore(target.sessionId);
  let resolveReady: ((messages: readonly StoredMessage[]) => void) | undefined;
  const ready = new Promise<readonly StoredMessage[]>((resolve) => {
    resolveReady = resolve;
  });
  let cancelOpen = () => {};
  let timedOut = false;
  let handle: DesktopTranscriptHandle | undefined;
  let rejectTimeout!: (error: Error) => void;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  void timeoutFailure.catch(() => undefined);
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    cancelOpen();
    rejectTimeout(new Error('WorkHub Session transcript did not become ready'));
  }, WORKHUB_TRANSCRIPT_READY_TIMEOUT_MS);
  const opening = transcripts.open(
    target.sessionId,
    (batch) => {
      store.accept(batch);
      if (batch.ready) resolveReady?.(store.snapshot().messages);
    },
    (cancel) => {
      cancelOpen = cancel;
      if (timedOut) cancel();
    },
  );
  void opening.catch(() => undefined);
  try {
    handle = await Promise.race([opening, timeoutFailure]);
    return await Promise.race([ready, timeoutFailure]);
  } finally {
    globalThis.clearTimeout(timeout);
    await handle?.close().catch(() => undefined);
  }
}

function projectState(session: WorkHubDesktopSession): WorkHubSessionState {
  // A root Turn can remain live while it is blocked on a user interaction.
  // WorkHub must surface that interaction boundary before the broader running
  // fact so it never attempts to enqueue a second root request.
  if (session.status === 'waiting_for_user') {
    return 'waiting_for_user';
  }
  if ((session.runningTurnIds?.length ?? 0) > 0 || session.status === 'running') {
    return 'running';
  }
  return session.status;
}

function projectDelegationExecutionState(input: {
  resolutionState: 'pending' | 'cancelled' | 'owned' | undefined;
  executionTurnId: string | undefined;
  session: WorkHubSessionFacts | undefined;
  turn: Partial<Pick<TurnRecord, 'turnId' | 'status' | 'statusSource'>> | undefined;
  turnReadFailed: boolean;
  executionReadFailed: boolean;
}): WorkHubDelegationFeedback['state'] {
  const { executionTurnId, session, turn } = input;
  if (input.executionReadFailed) return 'recovering';
  if (!input.resolutionState) return 'recovering';
  if (input.resolutionState === 'cancelled') return 'aborted';
  if (input.resolutionState === 'pending') return 'accepted';
  if (!executionTurnId) return 'recovering';
  if (turn?.statusSource === 'recorded' && turn.status && turn.status !== 'running') {
    return turn.status;
  }
  const liveTurnIds = session?.runningTurnIds;
  const ownsLiveTurn = liveTurnIds?.includes(executionTurnId) === true;
  if (ownsLiveTurn && session?.state === 'waiting_for_user') return 'waiting_for_user';
  if (ownsLiveTurn) return 'running';
  if (liveTurnIds === undefined && turn?.statusSource === 'recorded' && turn.status === 'running') {
    return 'running';
  }
  if (input.turnReadFailed || !session) return 'recovering';
  return 'accepted';
}
