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

import { isDeepStrictEqual } from 'node:util';
import {
  messageContentsEqual,
  normalizeMessageContent,
  type MessageContent,
} from '@maka/core/events';
import type {
  AdmitRootTurnInput,
  AdmitRootTurnResult,
  RootTurnAdmission,
  RootTurnAdmissionStore,
  RootTurnSourceMessage,
} from '@maka/storage/execution-stores';

type OwnedAdmitRootTurnInput = Omit<AdmitRootTurnInput, 'previousRootTurnId'>;
type Immutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly Immutable<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: Immutable<T[Key]> }
      : T;

export type ValidatedRootTurnAdmission = Immutable<RootTurnAdmission>;

export class RootAdmissionOwner {
  readonly #admissionsBySession = new Map<string, Map<string, RootTurnAdmission>>();
  readonly #tips = new Map<string, RootTurnAdmission>();
  readonly #poisonedSessions = new Set<string>();

  constructor(private readonly store: RootTurnAdmissionStore) {}

  latestAdmission(sessionId: string): ValidatedRootTurnAdmission | undefined {
    return this.#tips.get(sessionId);
  }

  assertKnownAdmission(admission: RootTurnAdmission): void {
    const known = this.#admissionsBySession.get(admission.sessionId)?.get(admission.turnId);
    if (!known || !sameRootAdmission(known, admission)) {
      throw new Error('Root Turn admission identity changed within one Host Epoch');
    }
  }

  async recoverSession(sessionId: string): Promise<readonly RootTurnAdmission[]> {
    if (this.#admissionsBySession.has(sessionId)) {
      throw new Error(`Root Turn recovery chain was already installed for Session ${sessionId}`);
    }
    const admissions = await this.store.listRootTurnAdmissionsForRecovery(sessionId);
    const snapshots = Object.freeze(admissions.map(snapshotAdmission));
    const byTurnId = new Map<string, RootTurnAdmission>();
    for (const admission of snapshots) byTurnId.set(admission.turnId, admission);
    this.#admissionsBySession.set(sessionId, byTurnId);
    const tip = snapshots.at(-1);
    if (tip) this.#tips.set(sessionId, tip);
    return snapshots;
  }

  async admitRootTurn(input: OwnedAdmitRootTurnInput): Promise<AdmitRootTurnResult> {
    if (this.#poisonedSessions.has(input.sessionId)) {
      throw new Error(`Root Turn admission state is uncertain for Session ${input.sessionId}`);
    }
    const current = this.#tips.get(input.sessionId);
    try {
      const result = await this.store.admitRootTurn({
        ...input,
        previousRootTurnId: current?.turnId ?? null,
      });
      const admission = result.admission;
      if (
        admission.sessionId !== input.sessionId ||
        admission.turnId !== input.turnId ||
        admission.previousRootTurnId !== (current?.turnId ?? null)
      ) {
        throw new Error('Durable Root Turn admission does not extend the owned chain');
      }

      const byTurnId = this.#admissionsBySession.get(input.sessionId) ?? new Map();
      const known = byTurnId.get(admission.turnId);
      if (known && !sameRootAdmission(known, admission)) {
        throw new Error('Root Turn admission identity changed within one Host Epoch');
      }
      const snapshot = snapshotAdmission(admission);
      byTurnId.set(admission.turnId, snapshot);
      this.#admissionsBySession.set(input.sessionId, byTurnId);
      this.#tips.set(input.sessionId, snapshot);
      return Object.freeze({ ...result, admission: snapshot });
    } catch (error) {
      this.#poisonedSessions.add(input.sessionId);
      throw error;
    }
  }
}

function sameRootAdmission(left: RootTurnAdmission, right: RootTurnAdmission): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.runId === right.runId &&
    left.userMessageId === right.userMessageId &&
    isDeepStrictEqual(left.execution, right.execution) &&
    isDeepStrictEqual(left.turnOrchestration, right.turnOrchestration) &&
    isDeepStrictEqual(left.skillInvocation, right.skillInvocation) &&
    left.previousRootTurnId === right.previousRootTurnId &&
    (left.normalizedInput === null || right.normalizedInput === null
      ? left.normalizedInput === right.normalizedInput
      : messageContentsEqual(left.normalizedInput, right.normalizedInput)) &&
    left.sourceMessages.length === right.sourceMessages.length &&
    left.sourceMessages.every((source, index) => {
      const other = right.sourceMessages[index];
      return (
        other !== undefined &&
        source.messageId === other.messageId &&
        source.placement === other.placement &&
        source.disposition === other.disposition &&
        source.submittedContentDigest === other.submittedContentDigest &&
        messageContentsEqual(source.content, other.content)
      );
    }) &&
    left.admittedAt === right.admittedAt
  );
}

function snapshotAdmission(admission: RootTurnAdmission): RootTurnAdmission {
  const sourceMessages = admission.sourceMessages.map(
    (source): RootTurnSourceMessage =>
      Object.freeze({
        ...source,
        content: snapshotMessageContent(source.content),
      }),
  );
  return Object.freeze({
    ...admission,
    execution: Object.freeze({ ...admission.execution }),
    ...(admission.turnOrchestration
      ? { turnOrchestration: Object.freeze({ ...admission.turnOrchestration }) }
      : {}),
    normalizedInput:
      admission.normalizedInput === null ? null : snapshotMessageContent(admission.normalizedInput),
    sourceMessages: Object.freeze(sourceMessages),
  });
}

function snapshotMessageContent(content: MessageContent): MessageContent {
  const snapshot = normalizeMessageContent(content);
  for (const attachment of snapshot.attachments ?? []) {
    Object.freeze(attachment.ref);
    Object.freeze(attachment);
  }
  if (snapshot.attachments) Object.freeze(snapshot.attachments);
  for (const quote of snapshot.quotes ?? []) Object.freeze(quote);
  if (snapshot.quotes) Object.freeze(snapshot.quotes);
  return Object.freeze(snapshot);
}
