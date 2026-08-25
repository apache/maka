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

import { deriveTurnRecords, type StoredMessage } from '@maka/core/session';
import type {
  DesktopTranscriptBatch,
  DesktopTranscriptHandle,
} from '../preload/transcript-contract.js';
import { parseDesktopSessionKey } from '../shared/runtime-host-identity.js';
import { DesktopTranscriptRangeStore } from './desktop-transcript-range-store.js';
import type {
  WorkHubProjectedTurn,
  WorkHubSessionFacts,
  WorkHubSessionPort,
  WorkHubSessionState,
  WorkHubSessionTarget,
} from './workhub-controller.js';
import {
  boundedWorkHubTimelineText,
  WorkHubSessionSubmitError,
} from './workhub-controller.js';

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
  listTurns(sessionId: string): Promise<readonly { userPromptPreview?: string }[]>;
  create(input: { name: string }): Promise<WorkHubDesktopSession>;
  send(
    sessionId: string,
    command: { type: 'send'; turnId: string; text: string },
  ): Promise<
    { ok: true; turnId: string; steered?: true } | { ok: false; reason: string }
  >;
  stop(
    sessionId: string,
    input?: { source?: 'stop_button'; expectedTurnId?: string },
  ): Promise<unknown>;
  subscribeChanges(handler: () => void): () => void;
}

export type WorkHubCoordinationHostSessionCreator = (
  coordinationSessionId: string,
  input: { name: string },
) => Promise<WorkHubDesktopSession>;

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

export function createDesktopWorkHubSessionPort(deps: {
  sessions: WorkHubDesktopSessionBridge;
  transcripts: WorkHubDesktopTranscriptBridge;
  projectName(projectId: string): string | undefined;
  newTurnId(): string;
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
    listCatalog() {
      return projectCatalog();
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
    async create({ name }) {
      return projectSession(await deps.sessions.create({ name }));
    },
    reserveTurnId() {
      return deps.newTurnId();
    },
    async submit(target: WorkHubSessionTarget, text: string, turnId: string) {
      let result: Awaited<ReturnType<WorkHubDesktopSessionBridge['send']>>;
      try {
        result = await deps.sessions.send(target.sessionId, {
          type: 'send',
          turnId,
          text,
        });
      } catch (cause) {
        throw new WorkHubSessionSubmitError(
          'WorkHub Session delivery outcome is unknown',
          'unknown',
          { cause },
        );
      }
      if (!result.ok) {
        throw new WorkHubSessionSubmitError(
          `WorkHub Session send failed: ${result.reason}`,
          'rejected',
        );
      }
      return {
        turnId: result.turnId,
        ...(result.steered ? { steered: true as const } : {}),
      };
    },
    async reconcileSubmission(target, reservedTurnId) {
      try {
        const messages = await readWorkHubSessionMessages(deps.transcripts, target);
        let message: Extract<StoredMessage, { type: 'user' }> | undefined;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const entry = messages[index];
          if (
            entry?.type === 'user' &&
            (entry.turnId === reservedTurnId || entry.id === reservedTurnId)
          ) {
            message = entry;
            break;
          }
        }
        if (!message) return { kind: 'unknown' };
        if (message.turnId === reservedTurnId) {
          return { kind: 'root', turnId: message.turnId };
        }
        return message.steeringEventId
          ? { kind: 'steered' }
          : { kind: 'root', turnId: message.turnId };
      } catch {
        return { kind: 'unknown' };
      }
    },
    async stop(target, expectedTurnId) {
      await deps.sessions.stop(target.sessionId, {
        source: 'stop_button',
        expectedTurnId,
      });
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
