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
import { isSideConversationSession } from '@maka/core/side-conversation';
import { isLinkedSubagentSession, type SessionSummary, type StoredMessage } from '@maka/core/session';
import {
  sessionMailboxMessageContent,
  sessionMailboxSentReceiptId,
  type SessionMailboxKind,
} from '@maka/core/session-mailbox';
import type { SessionStore } from '@maka/storage/session-store';
import type {
  SessionMailboxSendInput,
  SessionMailboxSendResult,
  SessionMailboxTarget,
} from '../protocol/index.js';
import type { HostMessageCoordinator } from './message-coordinator.js';
import type {
  ConnectionContext,
  SessionMailboxOperationHandlerMap,
} from './operation-dispatcher.js';

type MailboxErrorCode =
  | 'host_not_ready'
  | 'host_draining'
  | 'operation_unavailable'
  | 'not_found'
  | 'session_archived'
  | 'session_busy'
  | 'operation_conflict'
  | 'invalid_request'
  | 'outcome_unknown'
  | 'internal_failure';

type MailboxOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: MailboxErrorCode;
        readonly message: string;
      };
    };

export interface HostSessionMailboxCoordinatorOptions {
  readonly hostEpoch: string;
  readonly messages: Pick<HostMessageCoordinator, 'handlers'>;
  readonly listSessions: () => Promise<SessionSummary[]>;
  readonly sessionStore: Pick<SessionStore, 'appendMessage' | 'readMessagesSnapshot'>;
  readonly createId?: () => string;
  readonly now?: () => number;
}

/** Host-owned routing between ordinary root Sessions in one workspace. */
export class HostSessionMailboxCoordinator {
  readonly handlers: SessionMailboxOperationHandlerMap = {
    'session.mailbox.targets': (input) => this.#targets(input.sourceSessionId),
    'session.mailbox.send': (input, context) => this.#send(input, context.connectionId),
  };

  readonly #hostEpoch: string;
  readonly #messages: Pick<HostMessageCoordinator, 'handlers'>;
  readonly #listSessions: () => Promise<SessionSummary[]>;
  readonly #sessionStore: Pick<SessionStore, 'appendMessage' | 'readMessagesSnapshot'>;
  readonly #createId: () => string;
  readonly #now: () => number;

  constructor(options: HostSessionMailboxCoordinatorOptions) {
    this.#hostEpoch = options.hostEpoch;
    this.#messages = options.messages;
    this.#listSessions = options.listSessions;
    this.#sessionStore = options.sessionStore;
    this.#createId = options.createId ?? randomUUID;
    this.#now = options.now ?? Date.now;
  }

  async listTargets(sourceSessionId: string): Promise<readonly SessionMailboxTarget[]> {
    const outcome = await this.#targets(sourceSessionId);
    if (!outcome.ok) throw new Error(outcome.error.message);
    return outcome.result.targets;
  }

  async sendFromSession(input: {
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
    readonly kind: SessionMailboxKind;
    readonly text: string;
    readonly correlationId?: string;
  }): Promise<SessionMailboxSendResult> {
    const outcome = await this.#send(
      { ...input, messageId: this.#createId() },
      `session-mailbox:${input.sourceSessionId}`,
    );
    if (!outcome.ok) throw new Error(outcome.error.message);
    return outcome.result;
  }

  async #targets(
    sourceSessionId: string,
  ): Promise<MailboxOutcome<{ readonly targets: readonly SessionMailboxTarget[] }>> {
    const sessions = await this.#listSessions();
    const source = sessions.find((session) => session.id === sourceSessionId);
    if (!source || !isMailboxRoot(source)) {
      return failure('not_found', 'Source Session is not available for Session messaging');
    }
    if (source.isArchived) return failure('session_archived', 'Source Session is archived');
    const targets = sessions
      .filter(
        (candidate) =>
          candidate.id !== source.id &&
          !candidate.isArchived &&
          isMailboxRoot(candidate) &&
          sharesWorkspace(source, candidate),
      )
      .map(toMailboxTarget)
      .slice(0, 64);
    return success({ targets });
  }

  async #send(
    input: SessionMailboxSendInput,
    initiatingConnectionId: string,
  ): Promise<MailboxOutcome<SessionMailboxSendResult>> {
    if (input.sourceSessionId === input.targetSessionId) {
      return failure('invalid_request', 'A Session cannot send a message to itself');
    }
    const sessions = await this.#listSessions();
    const source = sessions.find((session) => session.id === input.sourceSessionId);
    const target = sessions.find((session) => session.id === input.targetSessionId);
    if (!source || !isMailboxRoot(source)) {
      return failure('not_found', 'Source Session is not available for Session messaging');
    }
    if (source.isArchived) return failure('session_archived', 'Source Session is archived');
    if (
      !target ||
      target.isArchived ||
      !isMailboxRoot(target) ||
      !sharesWorkspace(source, target)
    ) {
      return failure('not_found', 'Target Session is not reachable from this Session');
    }
    const submitted = await this.#messages.handlers['turn.message.submit'](
      {
        originHostEpoch: this.#hostEpoch,
        sessionId: target.id,
        messageId: input.messageId,
        content: sessionMailboxMessageContent({
          messageId: input.messageId,
          fromSessionId: source.id,
          fromSessionName: source.name,
          toSessionId: target.id,
          kind: input.kind,
          text: input.text,
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        }),
        placement: 'next_turn',
      },
      connectionContext(this.#hostEpoch, initiatingConnectionId),
    );
    if (!submitted.ok) {
      return failure(
        submitted.error.code === 'unauthorized' ? 'operation_unavailable' : submitted.error.code,
        submitted.error.message,
      );
    }
    const disposition = submitted.result.disposition === 'turn_started' ? 'turn_started' : 'queued';
    await this.#recordSentMessage(source.id, {
      messageId: input.messageId,
      targetSessionId: target.id,
      targetSessionName: target.name,
      kind: input.kind,
      text: input.text,
      disposition,
    });
    return success({
      messageId: input.messageId,
      targetSessionId: target.id,
      disposition,
      ...(submitted.result.disposition === 'turn_started'
        ? { turnId: submitted.result.turnId }
        : {}),
    });
  }

  async #recordSentMessage(
    sourceSessionId: string,
    data: {
      readonly messageId: string;
      readonly targetSessionId: string;
      readonly targetSessionName: string;
      readonly kind: SessionMailboxKind;
      readonly text: string;
      readonly disposition: 'turn_started' | 'queued';
    },
  ): Promise<void> {
    const receiptId = sessionMailboxSentReceiptId(data.messageId);
    try {
      const messages = await this.#sessionStore.readMessagesSnapshot(sourceSessionId);
      if (messages.some((message) => message.id === receiptId)) return;
      const anchorTurnId = latestTurnId(messages);
      await this.#sessionStore.appendMessage(sourceSessionId, {
        type: 'system_note',
        id: receiptId,
        ...(anchorTurnId ? { turnId: anchorTurnId } : {}),
        ts: this.#now(),
        kind: 'session_mailbox_sent',
        data,
      });
    } catch {
      // Delivery already succeeded and cannot be rolled back. The Client also
      // projects an optimistic receipt, so a storage-only receipt failure must
      // never invite a retry that sends the same message twice.
    }
  }
}

function latestTurnId(messages: readonly StoredMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const turnId = messages[index]?.turnId;
    if (turnId) return turnId;
  }
  return undefined;
}

function isMailboxRoot(session: SessionSummary): boolean {
  return !isLinkedSubagentSession(session) && !isSideConversationSession(session.labels);
}

function sharesWorkspace(source: SessionSummary, target: SessionSummary): boolean {
  if (source.projectId && target.projectId) return source.projectId === target.projectId;
  return source.cwd !== undefined && source.cwd === target.cwd;
}

function toMailboxTarget(session: SessionSummary): SessionMailboxTarget {
  return {
    sessionId: session.id,
    name: session.name,
    status:
      session.status === 'waiting_for_user'
        ? 'waiting_for_user'
        : (session.runningTurnIds?.length ?? 0) > 0
          ? 'running'
          : 'idle',
  };
}

function connectionContext(hostEpoch: string, connectionId: string): ConnectionContext {
  return {
    hostEpoch,
    connectionId,
    principal: 'runtime_host',
    acquireResidency: () => ({ release: () => undefined }),
  };
}

function success<T>(result: T): MailboxOutcome<T> {
  return { ok: true, result };
}

function failure(code: MailboxErrorCode, message: string): MailboxOutcome<never> {
  return { ok: false, error: { code, message } };
}
