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

import type { SessionExecutionProjection } from '../../../shared/session-execution-projection.js';
export type { SessionExecutionProjection } from '../../../shared/session-execution-projection.js';

/** Retain the last nonterminal identity for Stop and conservative controls even when observation is unavailable. */
export function activeHostTurn(projection: SessionExecutionProjection | undefined) {
  const turn = projection?.rootTurn;
  return turn && turn.status !== 'completed' && turn.status !== 'failed' && turn.status !== 'cancelled'
    ? turn : undefined;
}

/** Presentation fields only; the Host retains ownership of the lifecycle. */
export function chatTurnActivity(projection: SessionExecutionProjection | undefined) {
  if (!projection?.available) return undefined;
  const turn = activeHostTurn(projection);
  return turn ? {
    turnId: turn.turnId,
    awaitingInput: turn.status === 'waiting_for_user',
    compacting: turn.rootExecutionKind === 'context_compact',
  } : undefined;
}
