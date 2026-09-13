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

import { defineObjectShape, hasExactShape, isRecord } from './record-schema.js';
import type { RuntimeEvent } from './runtime-event.js';
import type { ContinuationClaimV1, ImmutableRuntimePrefixV1 } from './runtime-boundary.js';
import { stableJsonStringify } from './tool-args-identity.js';

/**
 * A physical invocation's final fact, not completion of its logical Turn.
 * Root admission remains the execution authority. This seal authorizes exactly
 * one successor physical attempt, claimed only when it is actually dispatched.
 */
export interface RuntimeHandoffPause {
  readonly protocol: 'runtime_handoff_pause_v1';
  readonly handoffId: string;
  readonly hostEpoch: string;
  readonly rootRunId: string;
  readonly successorRunId: string;
  readonly successorInvocationId: string;
  readonly claimId: string;
  /** Runtime-observed budget for the successor; null means unbounded. */
  readonly remainingSteps: number | null;
}

export type RuntimeHandoffIntent = Omit<RuntimeHandoffPause, 'remainingSteps'>;

const PAUSE_SHAPE = defineObjectShape<RuntimeHandoffPause>()(
  [
    'protocol',
    'handoffId',
    'hostEpoch',
    'rootRunId',
    'successorRunId',
    'successorInvocationId',
    'claimId',
    'remainingSteps',
  ],
  [],
);

export function isRuntimeHandoffPause(value: unknown): value is RuntimeHandoffPause {
  return (
    isRecord(value) &&
    hasExactShape(value, PAUSE_SHAPE) &&
    value.protocol === 'runtime_handoff_pause_v1' &&
    (value.remainingSteps === null ||
      (Number.isSafeInteger(value.remainingSteps) && (value.remainingSteps as number) > 0)) &&
    [
      value.handoffId,
      value.hostEpoch,
      value.rootRunId,
      value.successorRunId,
      value.successorInvocationId,
      value.claimId,
    ].every(
      (id) =>
        typeof id === 'string' &&
        id.length > 0 &&
        id.length <= 256 &&
        !/[\u0000-\u001f\u007f]/u.test(id),
    )
  );
}

/** The seal cannot simultaneously publish content or claim a logical outcome. */
export function runtimeHandoffPause(event: RuntimeEvent): RuntimeHandoffPause | undefined {
  const pause = event.actions?.handoffPause;
  if (pause === undefined) return undefined;
  if (
    !isRuntimeHandoffPause(pause) ||
    event.partial !== false ||
    event.role !== 'system' ||
    (event.author !== 'host' && event.author !== 'system') ||
    event.status !== undefined ||
    event.content !== undefined ||
    event.actions?.endInvocation !== true ||
    Object.keys(event.actions).some((key) => key !== 'endInvocation' && key !== 'handoffPause') ||
    pause.successorRunId === event.runId ||
    pause.successorRunId === event.invocationId ||
    pause.successorInvocationId === event.invocationId ||
    pause.successorRunId === pause.rootRunId
  ) {
    throw new Error('Invalid Runtime handoff pause seal');
  }
  return pause;
}

/** Verify against source facts, not the proposed claim's description of them. */
export function assertHandoffClaimSource(
  claim: ContinuationClaimV1,
  prefix: ImmutableRuntimePrefixV1,
): void {
  const last = prefix.events.at(-1);
  const pause = last && runtimeHandoffPause(last);
  const source = claim.targetOpening.source;
  if (source.kind !== 'handoff') {
    if (pause) throw new Error('A handoff pause is reserved for its authorized successor');
    return;
  }
  const opening = prefix.events[0]?.content;
  if (
    !pause ||
    opening?.kind !== 'invocation_opened' ||
    prefix.identity.sessionId !== claim.target.sessionId ||
    prefix.identity.turnId !== claim.target.turnId ||
    pause.claimId !== claim.claimId ||
    pause.successorRunId !== claim.target.runId ||
    pause.successorInvocationId !== claim.target.invocationId ||
    pause.rootRunId !== source.rootRunId ||
    pause.rootRunId !==
      (opening.source.kind === 'handoff' ? opening.source.rootRunId : prefix.identity.runId) ||
    stableJsonStringify(opening.root) !== stableJsonStringify(claim.targetOpening.root) ||
    stableJsonStringify(opening.configuration) !==
      stableJsonStringify(claim.targetOpening.configuration) ||
    stableJsonStringify(opening.lineage ?? null) !==
      stableJsonStringify(claim.targetOpening.lineage ?? null)
  ) {
    throw new Error('Handoff claim does not preserve the sealed source authority');
  }
}
