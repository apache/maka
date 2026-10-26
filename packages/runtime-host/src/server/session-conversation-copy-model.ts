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

import { createHash } from 'node:crypto';
import { SIDE_CONVERSATION_SESSION_LABEL } from '@maka/core/side-conversation';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import {
  isWorkHubCoordinationSessionTarget,
  type SessionConversationCopy,
  type SessionHeader,
} from '@maka/core/session';
import type { SessionConversationCopyInput } from '../protocol/session-revision.js';

export type ConversationCopyKind = 'branch' | 'revision';
export type ConversationCopySemanticKind = ConversationCopyKind | 'side_conversation';
export type ConversationCopyCreateInput = CreateSessionInput & {
  branchNameOrigin?: SessionHeader['branchNameOrigin'];
  readonly conversationCopy: SessionConversationCopy;
};

/** Build the copied header from the validated snapshot; no I/O or lease ownership. */
export function createConversationCopyInput(
  kind: ConversationCopySemanticKind,
  input: SessionConversationCopyInput,
  requestFingerprint: `sha256:${string}`,
  source: SessionHeader,
  cwd: string,
  sessionHeaders: readonly SessionHeader[],
): ConversationCopyCreateInput {
  const derivesFromCoordination =
    isWorkHubCoordinationSessionTarget(source) && isEmptySideConversation(kind, input);
  const common: ConversationCopyCreateInput = {
    cwd,
    ...(source.projectId !== undefined ? { projectId: source.projectId } : {}),
    ...(source.llmConnectionId === undefined ? {} : { llmConnectionId: source.llmConnectionId }),
    llmConnectionSlug: source.llmConnectionSlug,
    model: source.model,
    ...(source.thinkingLevel !== undefined ? { thinkingLevel: source.thinkingLevel } : {}),
    permissionMode: derivesFromCoordination ? 'ask' : source.permissionMode,
    toolMode: source.toolMode ?? 'direct',
    collaborationMode: source.collaborationMode ?? 'agent',
    orchestrationMode: source.orchestrationMode ?? 'default',
    name: source.name,
    ...(kind === 'revision' && source.branchNameOrigin
      ? { branchNameOrigin: source.branchNameOrigin }
      : {}),
    labels:
      kind === 'side_conversation'
        ? derivesFromCoordination
          ? [SIDE_CONVERSATION_SESSION_LABEL]
          : [...new Set([...source.labels, SIDE_CONVERSATION_SESSION_LABEL])]
        : [...source.labels],
    conversationCopy: {
      kind: persistedConversationCopyKind(kind),
      sourceSessionId: input.sourceSessionId,
      ...(input.sourceTurnId === undefined ? {} : { sourceTurnId: input.sourceTurnId }),
      requestFingerprint,
      state: 'preparing',
      ...(kind === 'side_conversation' ? { intent: kind } : {}),
    },
    status: 'active',
  };
  if (kind !== 'revision') {
    // An empty copy records provenance but fabricates no branch turn.
    return {
      ...common,
      parentSessionId: input.sourceSessionId,
      ...(input.sourceTurnId === undefined ? {} : { branchOfTurnId: input.sourceTurnId }),
    };
  }
  // Revision copies always carry a turn boundary (enforced at decode).
  if (input.sourceTurnId === undefined) {
    throw new Error('Session revision copy requires a turn boundary');
  }
  const revisionOfTurnId = input.sourceTurnId;
  const revisionRootSessionId = source.revisionRootSessionId ?? input.sourceSessionId;
  const family = sessionHeaders.filter(
    (candidate) =>
      candidate.conversationCopy?.state !== 'preparing' &&
      (candidate.id === revisionRootSessionId ||
        candidate.revisionRootSessionId === revisionRootSessionId),
  );
  const revisionIndex = Math.max(1, ...family.map((candidate) => candidate.revisionIndex ?? 1)) + 1;
  return {
    ...common,
    ...(source.parentSessionId ? { parentSessionId: source.parentSessionId } : {}),
    ...(source.branchOfTurnId ? { branchOfTurnId: source.branchOfTurnId } : {}),
    revisionRootSessionId,
    revisionParentSessionId: input.sourceSessionId,
    revisionOfTurnId,
    revisionIndex,
    revisionState: 'preparing',
  };
}

export function conversationCopyFingerprint(
  kind: ConversationCopySemanticKind,
  input: SessionConversationCopyInput,
): `sha256:${string}` {
  // The optimistic source revision guards only the initial create. Once this
  // target exists, its stable identity must resolve the committed outcome even
  // if a reconnecting Client observes a newer source revision.
  const identity = [
    kind === 'side_conversation' ? 'session.conversation-copy.v2' : 'session.conversation-copy.v1',
    kind,
    input.sourceSessionId,
    input.targetSessionId,
    // Absent for an empty copy. JSON.stringify renders the missing element as
    // null, so an empty copy gets a distinct identity while through_turn and
    // revision hashes stay byte-identical to a required sourceTurnId.
    input.sourceTurnId,
  ];
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(input.worktree ? [...identity, input.worktree] : identity))
    .digest('hex')}`;
}

export function conversationCopySemanticKind(
  kind: ConversationCopyKind,
  input: SessionConversationCopyInput,
): ConversationCopySemanticKind {
  return kind === 'branch' && input.intent === 'side_conversation' ? input.intent : kind;
}

export function isEmptySideConversation(
  kind: ConversationCopySemanticKind,
  input: SessionConversationCopyInput,
): boolean {
  return kind === 'side_conversation' && input.sourceTurnId === undefined;
}

export function persistedConversationCopyKind(
  kind: ConversationCopySemanticKind,
): ConversationCopyKind {
  return kind === 'revision' ? 'revision' : 'branch';
}
