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
import {
  isLinkedSubagentSession,
  type SessionSummary,
  type StoredMessage,
} from '@maka/core/session';
import {
  parseSessionMailboxFailedNoteData,
  sessionMailboxMessageContent,
  sessionMailboxFailedReceiptId,
  sessionMailboxOutboxAttemptId,
  sessionMailboxSentReceiptId,
  sessionMailboxTurnOrigin,
  parseSessionMailboxOutboxNoteData,
  parseSessionMailboxSentNoteData,
  type SessionMailboxKind,
  type SessionMailboxFailedNoteData,
  type SessionMailboxOutboxNoteData,
  type SessionMailboxSentNoteData,
} from '@maka/core/session-mailbox';
import type { SessionStore } from '@maka/storage/session-store';
import type {
  SessionMailboxSendInput,
  SessionMailboxSendResult,
  SessionMailboxTarget,
} from '../protocol/index.js';
import { SESSION_MAILBOX_TARGET_MAX_ITEMS } from '../protocol/index.js';
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

const MAILBOX_ERROR_CODES = new Set<MailboxErrorCode>([
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'session_archived',
  'session_busy',
  'operation_conflict',
  'invalid_request',
  'outcome_unknown',
  'internal_failure',
]);

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
  readonly messages: Pick<HostMessageCoordinator, 'submitTrusted' | 'reconcileTrustedSubmit'>;
  readonly listSessions: () => Promise<SessionSummary[]>;
  readonly sessionStore: Pick<SessionStore, 'appendMessage' | 'readMessagesSnapshot'>;
  readonly createId?: () => string;
  readonly now?: () => number;
}

/** Host-owned routing between ordinary root Sessions in one project. */
export class HostSessionMailboxCoordinator {
  readonly handlers: SessionMailboxOperationHandlerMap = {
    'session.mailbox.targets': (input) => this.#targets(input.sourceSessionId),
    'session.mailbox.send': (input, context) => this.#send(input, context.connectionId),
  };

  readonly #hostEpoch: string;
  readonly #messages: Pick<HostMessageCoordinator, 'submitTrusted' | 'reconcileTrustedSubmit'>;
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

  /** Repair durable sender outboxes after a Host restart. */
  async recover(): Promise<void> {
    const sessions = await this.#listSessions();
    const byId = new Map(sessions.map((session) => [session.id, session]));
    for (const source of sessions) {
      if (!isMailboxRoot(source)) continue;
      let messages: readonly StoredMessage[];
      try {
        messages = await this.#sessionStore.readMessagesSnapshot(source.id);
      } catch {
        continue;
      }
      const settled = new Set<string>();
      for (const message of messages) {
        if (message.type !== 'system_note') continue;
        if (message.kind === 'session_mailbox_sent') {
          const receipt = parseSessionMailboxSentNoteData(message.data);
          if (receipt) settled.add(receipt.messageId);
        } else if (message.kind === 'session_mailbox_failed') {
          const rejection = parseSessionMailboxFailedNoteData(message.data);
          if (rejection) settled.add(rejection.messageId);
        }
      }
      const pending = new Map<string, SessionMailboxOutboxNoteData>();
      for (const message of messages) {
        if (message.type !== 'system_note' || message.kind !== 'session_mailbox_outbox') continue;
        const outbox = parseSessionMailboxOutboxNoteData(message.data);
        if (outbox && !settled.has(outbox.messageId)) pending.set(outbox.messageId, outbox);
      }
      for (const outbox of pending.values()) {
        if (!byId.has(outbox.toSessionId)) continue;
        await this.#deliverOutbox(outbox, `session-mailbox-recovery:${source.id}`, true).catch(
          () => undefined,
        );
      }
    }
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
          sharesProject(source, candidate),
      )
      .map(toMailboxTarget)
      .slice(0, SESSION_MAILBOX_TARGET_MAX_ITEMS);
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
    if (!target || target.isArchived || !isMailboxRoot(target) || !sharesProject(source, target)) {
      return failure('not_found', 'Target Session is not reachable from this Session');
    }
    const outbox: SessionMailboxOutboxNoteData = {
      originHostEpoch: this.#hostEpoch,
      messageId: input.messageId,
      fromSessionId: source.id,
      fromSessionName: source.name,
      toSessionId: target.id,
      targetSessionName: target.name,
      kind: input.kind,
      text: input.text,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    };
    const existing = await this.#readExistingResult(source.id, outbox);
    if (existing) return existing;
    await this.#persistOutboxAttempt(source.id, outbox);
    return this.#deliverOutbox(outbox, initiatingConnectionId, false);
  }

  async #deliverOutbox(
    initialOutbox: SessionMailboxOutboxNoteData,
    initiatingConnectionId: string,
    reconcileFirst: boolean,
  ): Promise<MailboxOutcome<SessionMailboxSendResult>> {
    let outbox = initialOutbox;
    let submitted = reconcileFirst
      ? await this.#messages.reconcileTrustedSubmit(
          submitInput(outbox),
          sessionMailboxTurnOrigin(outbox),
        )
      : undefined;
    if (submitted === undefined) {
      if (outbox.originHostEpoch !== this.#hostEpoch) {
        outbox = { ...outbox, originHostEpoch: this.#hostEpoch };
        await this.#persistOutboxAttempt(outbox.fromSessionId, outbox);
      }
      submitted = await this.#messages.submitTrusted(
        submitInput(outbox),
        connectionContext(this.#hostEpoch, initiatingConnectionId),
        sessionMailboxTurnOrigin(outbox),
      );
    }
    if (!submitted.ok) {
      if (submitted.error.code !== 'outcome_unknown') {
        await this.#recordFailedMessage(outbox.fromSessionId, {
          ...outbox,
          errorCode: submitted.error.code,
          errorMessage: submitted.error.message,
        });
      }
      return failure(submitted.error.code, submitted.error.message);
    }
    const disposition = submitted.result.disposition === 'turn_started' ? 'turn_started' : 'queued';
    const receipt: SessionMailboxSentNoteData = {
      messageId: outbox.messageId,
      targetSessionId: outbox.toSessionId,
      targetSessionName: outbox.targetSessionName,
      kind: outbox.kind,
      text: outbox.text,
      ...(outbox.correlationId ? { correlationId: outbox.correlationId } : {}),
      disposition,
      ...(submitted.result.disposition === 'turn_started'
        ? { turnId: submitted.result.turnId }
        : {}),
    };
    try {
      await this.#recordSentMessage(outbox.fromSessionId, receipt);
    } catch {
      // The pre-admission outbox remains durable. Startup recovery replays the
      // Host receipt/proof and repairs this settlement without redelivery.
    }
    return success({
      messageId: outbox.messageId,
      targetSessionId: outbox.toSessionId,
      disposition,
      ...(submitted.result.disposition === 'turn_started'
        ? { turnId: submitted.result.turnId }
        : {}),
    });
  }

  async #readExistingResult(
    sourceSessionId: string,
    outbox: SessionMailboxOutboxNoteData,
  ): Promise<MailboxOutcome<SessionMailboxSendResult> | undefined> {
    const messages = await this.#sessionStore.readMessagesSnapshot(sourceSessionId);
    const receiptMessage = messages.find(
      (message) => message.id === sessionMailboxSentReceiptId(outbox.messageId),
    );
    const failedMessage = messages.find(
      (message) => message.id === sessionMailboxFailedReceiptId(outbox.messageId),
    );
    if (receiptMessage && failedMessage) {
      return failure(
        'operation_conflict',
        'Mailbox message identity has multiple terminal results',
      );
    }
    if (receiptMessage) {
      const receipt =
        receiptMessage.type === 'system_note'
          ? parseSessionMailboxSentNoteData(receiptMessage.data)
          : undefined;
      if (!receipt || !receiptMatchesOutbox(receipt, outbox)) {
        return failure('operation_conflict', 'Mailbox message identity has different durable data');
      }
      return success({
        messageId: receipt.messageId,
        targetSessionId: receipt.targetSessionId,
        disposition: receipt.disposition,
        ...(receipt.turnId ? { turnId: receipt.turnId } : {}),
      });
    }
    if (!failedMessage) return undefined;
    const rejection =
      failedMessage.type === 'system_note'
        ? parseSessionMailboxFailedNoteData(failedMessage.data)
        : undefined;
    if (
      !rejection ||
      !failureMatchesOutbox(rejection, outbox) ||
      !isMailboxErrorCode(rejection.errorCode)
    ) {
      return failure('operation_conflict', 'Mailbox message identity has different durable data');
    }
    return failure(rejection.errorCode, rejection.errorMessage);
  }

  async #persistOutboxAttempt(
    sourceSessionId: string,
    data: SessionMailboxOutboxNoteData,
  ): Promise<void> {
    const id = sessionMailboxOutboxAttemptId(data.messageId, data.originHostEpoch);
    const messages = await this.#sessionStore.readMessagesSnapshot(sourceSessionId);
    const existing = messages.find((message) => message.id === id);
    if (existing) {
      const persisted =
        existing.type === 'system_note'
          ? parseSessionMailboxOutboxNoteData(existing.data)
          : undefined;
      if (!persisted || !outboxDataEqual(persisted, data)) {
        throw new Error('Mailbox outbox identity has different durable data');
      }
      return;
    }
    const anchorTurnId = latestTurnId(messages);
    await this.#sessionStore.appendMessage(sourceSessionId, {
      type: 'system_note',
      id,
      ...(anchorTurnId ? { turnId: anchorTurnId } : {}),
      ts: this.#now(),
      kind: 'session_mailbox_outbox',
      data,
    });
  }

  async #recordSentMessage(
    sourceSessionId: string,
    data: SessionMailboxSentNoteData,
  ): Promise<void> {
    const receiptId = sessionMailboxSentReceiptId(data.messageId);
    const messages = await this.#sessionStore.readMessagesSnapshot(sourceSessionId);
    const existing = messages.find((message) => message.id === receiptId);
    if (existing) {
      const persisted =
        existing.type === 'system_note'
          ? parseSessionMailboxSentNoteData(existing.data)
          : undefined;
      if (!persisted || !sentDataEqual(persisted, data)) {
        throw new Error('Mailbox receipt identity has different durable data');
      }
      return;
    }
    const anchorTurnId = latestTurnId(messages);
    await this.#sessionStore.appendMessage(sourceSessionId, {
      type: 'system_note',
      id: receiptId,
      ...(anchorTurnId ? { turnId: anchorTurnId } : {}),
      ts: this.#now(),
      kind: 'session_mailbox_sent',
      data,
    });
  }

  async #recordFailedMessage(
    sourceSessionId: string,
    data: SessionMailboxFailedNoteData,
  ): Promise<void> {
    const receiptId = sessionMailboxFailedReceiptId(data.messageId);
    const messages = await this.#sessionStore.readMessagesSnapshot(sourceSessionId);
    const existing = messages.find((message) => message.id === receiptId);
    if (existing) {
      const persisted =
        existing.type === 'system_note'
          ? parseSessionMailboxFailedNoteData(existing.data)
          : undefined;
      if (!persisted || !failedDataEqual(persisted, data)) {
        throw new Error('Mailbox failure identity has different durable data');
      }
      return;
    }
    const anchorTurnId = latestTurnId(messages);
    await this.#sessionStore.appendMessage(sourceSessionId, {
      type: 'system_note',
      id: receiptId,
      ...(anchorTurnId ? { turnId: anchorTurnId } : {}),
      ts: this.#now(),
      kind: 'session_mailbox_failed',
      data,
    });
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

function sharesProject(source: SessionSummary, target: SessionSummary): boolean {
  if (source.projectId && target.projectId) return source.projectId === target.projectId;
  return source.cwd !== undefined && source.cwd === target.cwd;
}

function submitInput(outbox: SessionMailboxOutboxNoteData) {
  return {
    originHostEpoch: outbox.originHostEpoch,
    sessionId: outbox.toSessionId,
    messageId: outbox.messageId,
    content: sessionMailboxMessageContent(outbox),
    placement: 'next_turn' as const,
  };
}

function receiptMatchesOutbox(
  receipt: SessionMailboxSentNoteData,
  outbox: SessionMailboxOutboxNoteData,
): boolean {
  return (
    receipt.messageId === outbox.messageId &&
    receipt.targetSessionId === outbox.toSessionId &&
    receipt.targetSessionName === outbox.targetSessionName &&
    receipt.kind === outbox.kind &&
    receipt.text === outbox.text &&
    receipt.correlationId === outbox.correlationId
  );
}

function sentDataEqual(
  left: SessionMailboxSentNoteData,
  right: SessionMailboxSentNoteData,
): boolean {
  return (
    receiptMatchesOutbox(left, {
      originHostEpoch: '',
      messageId: right.messageId,
      fromSessionId: '',
      fromSessionName: '',
      toSessionId: right.targetSessionId,
      targetSessionName: right.targetSessionName,
      kind: right.kind,
      text: right.text,
      ...(right.correlationId ? { correlationId: right.correlationId } : {}),
    }) &&
    left.disposition === right.disposition &&
    left.turnId === right.turnId
  );
}

function failureMatchesOutbox(
  failureData: SessionMailboxFailedNoteData,
  outbox: SessionMailboxOutboxNoteData,
): boolean {
  return (
    failureData.messageId === outbox.messageId &&
    failureData.fromSessionId === outbox.fromSessionId &&
    failureData.fromSessionName === outbox.fromSessionName &&
    failureData.toSessionId === outbox.toSessionId &&
    failureData.targetSessionName === outbox.targetSessionName &&
    failureData.kind === outbox.kind &&
    failureData.text === outbox.text &&
    failureData.correlationId === outbox.correlationId
  );
}

function failedDataEqual(
  left: SessionMailboxFailedNoteData,
  right: SessionMailboxFailedNoteData,
): boolean {
  return (
    outboxDataEqual(left, right) &&
    left.errorCode === right.errorCode &&
    left.errorMessage === right.errorMessage
  );
}

function isMailboxErrorCode(value: string): value is MailboxErrorCode {
  return MAILBOX_ERROR_CODES.has(value as MailboxErrorCode);
}

function outboxDataEqual(
  left: SessionMailboxOutboxNoteData,
  right: SessionMailboxOutboxNoteData,
): boolean {
  return (
    left.originHostEpoch === right.originHostEpoch &&
    left.messageId === right.messageId &&
    left.fromSessionId === right.fromSessionId &&
    left.fromSessionName === right.fromSessionName &&
    left.toSessionId === right.toSessionId &&
    left.targetSessionName === right.targetSessionName &&
    left.kind === right.kind &&
    left.text === right.text &&
    left.correlationId === right.correlationId
  );
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
