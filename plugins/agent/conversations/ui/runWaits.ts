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

import type { AgentExecution } from '../../../../packages/plugin-sdk/src/generated/runtime.js';
import type { ConversationStatus } from '../../../../products/maka/workbench/app/sessionStatus';

type WaitingState = Extract<AgentExecution['state'], { kind: 'waiting' }>;

export type RunWait = WaitingState['waits'][number]['kind'];

function needsUserAction(state: WaitingState): boolean {
  return (
    state.authorityUnavailable ||
    state.waits.some(({ kind }) => kind === 'approval' || kind === 'blocker')
  );
}

/**
 * What a waiting run waits for while nobody has to act: a provider retry, a
 * code cell, a child run. A run waiting on an approval, or on access to be
 * restored, needs the person, so none of its waits are quiet.
 */
export function quietWaits(execution: AgentExecution | null): RunWait[] {
  const state = execution?.state;
  if (state?.kind !== 'waiting' || needsUserAction(state)) return [];
  return state.waits.map(({ kind }) => kind);
}

/** The run waits to send a model request again. */
export const retrying = (waits: readonly RunWait[]) =>
  waits.includes('provider_backoff') || waits.includes('retry');

export function waitActivity(
  status: ConversationStatus,
  execution: AgentExecution | null,
  hasPendingInteraction = false,
): 'waiting_for_user' | 'retrying' | undefined {
  if (status === 'waiting_for_user') return 'waiting_for_user';
  if (
    hasPendingInteraction &&
    (status === 'admitted' || status === 'running' || status === 'waiting')
  )
    return 'waiting_for_user';
  if (status !== 'waiting') return;
  const state = execution?.state;
  if (state?.kind !== 'waiting') return;
  if (needsUserAction(state)) return 'waiting_for_user';
  if (retrying(state.waits.map(({ kind }) => kind))) return 'retrying';
}
