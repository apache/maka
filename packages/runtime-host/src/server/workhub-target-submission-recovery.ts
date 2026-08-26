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
  messageContentDigest,
  normalizeMessageContent,
  type MessageContent,
} from '@maka/core/events';
import type {
  ImmutableSteeringMessageProof,
  RootTurnAdmission,
  RootTurnSourceMessageReceipt,
} from '@maka/storage/agent-run-store';
import { WorkHubActionEffectFailure } from './workhub-coordination-action-gate.js';

interface WorkHubPendingMessageAdmission {
  readonly turnId: string;
  readonly runId: string;
  readonly submittedPlacement: 'current_turn' | 'next_turn';
  readonly submittedContentDigest: `sha256:${string}`;
}

export interface WorkHubSubmissionRecoveryStores {
  readRootTurnSourceMessageReceipt(
    sessionId: string,
    messageId: string,
  ): Promise<RootTurnSourceMessageReceipt | undefined>;
  readMessageAdmission(
    sessionId: string,
    messageId: string,
  ): Promise<WorkHubPendingMessageAdmission | undefined>;
  readRootTurnAdmission(sessionId: string, turnId: string): Promise<RootTurnAdmission | undefined>;
  readImmutableSteeringMessageProof(
    sessionId: string,
    messageId: string,
  ): Promise<ImmutableSteeringMessageProof | undefined>;
}

export async function recoverWorkHubTargetSubmission(
  stores: WorkHubSubmissionRecoveryStores,
  input: { readonly sessionId: string; readonly messageId: string; readonly text: string },
): Promise<{ readonly turnId: string; readonly steered?: true } | undefined> {
  const content = normalizeMessageContent({ text: input.text });
  const expectedDigest = messageContentDigest(content);
  const receipt = await stores.readRootTurnSourceMessageReceipt(input.sessionId, input.messageId);
  if (receipt) {
    const source = receipt.sourceMessage;
    const actualDigest = source.submittedContentDigest ?? messageContentDigest(source.content);
    assertMatchingSubmission(source.placement, actualDigest, expectedDigest);
    return source.disposition === 'turn_started'
      ? { turnId: receipt.admission.turnId }
      : source.disposition === 'steering'
        ? { turnId: receipt.admission.turnId, steered: true }
        : undefined;
  }

  const steeringProof = await stores.readImmutableSteeringMessageProof(
    input.sessionId,
    input.messageId,
  );
  if (steeringProof) {
    const proofContent = workHubSteeringProofContent(steeringProof);
    const proofDigest =
      steeringProof.event.refs?.sourceMessageDigest ??
      (proofContent ? messageContentDigest(proofContent) : undefined);
    if (
      steeringProof.event.content?.kind !== 'text' ||
      steeringProof.event.content.steering !== true ||
      proofDigest !== expectedDigest
    ) {
      throw new WorkHubActionEffectFailure(
        'operation_conflict',
        'WorkHub target steering identity belongs to different content',
      );
    }
    return { turnId: steeringProof.event.turnId, steered: true };
  }

  const admission = await stores.readMessageAdmission(input.sessionId, input.messageId);
  if (!admission) return undefined;
  assertMatchingSubmission(
    admission.submittedPlacement,
    admission.submittedContentDigest,
    expectedDigest,
  );
  const root = await stores.readRootTurnAdmission(input.sessionId, admission.turnId);
  if (!root || root.runId !== admission.runId) return undefined;
  return { turnId: admission.turnId, steered: true };
}

function assertMatchingSubmission(
  placement: 'current_turn' | 'next_turn',
  actualDigest: string,
  expectedDigest: string,
): void {
  if (placement !== 'current_turn' || actualDigest !== expectedDigest) {
    throw new WorkHubActionEffectFailure(
      'operation_conflict',
      'WorkHub target Message identity belongs to different content',
    );
  }
}

export function workHubSteeringProofContent(
  proof: ImmutableSteeringMessageProof,
): MessageContent | undefined {
  return proof.event.content?.kind === 'text'
    ? normalizeMessageContent(proof.event.content)
    : undefined;
}
