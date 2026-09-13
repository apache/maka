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

import type {
  AgentGraphIntentClaimResult,
  AgentGraphIntentClaimStore,
} from '@maka/core/agent-graph-control';
import { AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION } from '@maka/core/agent-graph-control';
import { stableHash } from './request-shape.js';
import type { AgentGraphRunnableIntent } from './stream-graph-readiness.js';

const AGENT_GRAPH_EXECUTION_INPUT_SCHEMA_VERSION = 1 as const;

export interface AgentGraphRunnableIntentExecutionInput {
  prompt: string;
}

export interface FingerprintAgentGraphRunnableIntentInput {
  intent: AgentGraphRunnableIntent;
  executionInput: AgentGraphRunnableIntentExecutionInput;
}

export interface ClaimAgentGraphRunnableIntentInput {
  intent: AgentGraphRunnableIntent;
  store: Pick<AgentGraphIntentClaimStore, 'claimAgentGraphIntent'>;
  newId: () => string;
  /** Reuse topology-provisioned identities for a newly materialized operator. */
  targetTurnId?: string;
  targetRunId?: string;
  /**
   * Stable execution input resolved before admission.
   *
   * This must be bound before the durable claim is written so a crash after
   * admission but before the Runtime message is durable cannot retry the same
   * intent with different work.
   */
  executionInput: AgentGraphRunnableIntentExecutionInput;
}

/**
 * Binds the complete runnable intent to its resolved execution input.
 *
 * Claim and execution must both use this helper so the durable claim remains
 * authoritative for the first execution as well as retries.
 */
export function fingerprintAgentGraphRunnableIntent(
  input: FingerprintAgentGraphRunnableIntentInput,
): string {
  if (!input.executionInput.prompt.trim()) {
    throw new Error('Agent graph execution prompt must not be empty');
  }
  return stableHash({
    schemaVersion: AGENT_GRAPH_EXECUTION_INPUT_SCHEMA_VERSION,
    intent: input.intent,
    executionInput: input.executionInput,
  });
}

/**
 * Claims a deterministic readiness intent without invoking Agent runtime.
 *
 * The store is the admission authority. Proposed ids are disposable on an
 * idempotent retry: the persisted turn/run identity always wins.
 */
export function claimAgentGraphRunnableIntent(
  input: ClaimAgentGraphRunnableIntentInput,
): Promise<AgentGraphIntentClaimResult> {
  const intentFingerprint = fingerprintAgentGraphRunnableIntent({
    intent: input.intent,
    executionInput: input.executionInput,
  });
  const claimHash = stableHash({
    schemaVersion: AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION,
    graphId: input.intent.graphId,
    intentId: input.intent.intentId,
  });
  return input.store.claimAgentGraphIntent({
    schemaVersion: AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION,
    claimId: `graph_claim_${claimHash.slice('sha256:'.length, 'sha256:'.length + 32)}`,
    graphId: input.intent.graphId,
    intentId: input.intent.intentId,
    intentFingerprint,
    readinessContextFingerprint: input.intent.readinessContextFingerprint,
    targetOperatorId: input.intent.operatorId,
    targetSessionId: input.intent.targetSessionId,
    targetTurnId: input.targetTurnId ?? input.newId(),
    targetRunId: input.targetRunId ?? input.newId(),
  });
}
