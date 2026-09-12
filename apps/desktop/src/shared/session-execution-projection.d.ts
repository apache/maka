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

import type { TurnSnapshot } from '@maka/runtime-host/protocol';
import type { SessionEvent } from '@maka/core/events';

/** Desktop observation data, never a Runtime event or a client execution claim. */
export interface SessionExecutionProjection {
  readonly type: 'host_execution';
  readonly available: boolean;
  readonly rootTurn: TurnSnapshot | null;
}

export type SessionObservationMessage = SessionExecutionProjection | {
  readonly type: 'host_observation_seed';
  /** Only registered subscribers consume this seed, including during recovery. */
  readonly observerIds: readonly string[];
  readonly execution: SessionExecutionProjection;
  readonly events: readonly SessionEvent[];
} | {
  readonly type: 'host_observation_pending';
} | {
  readonly type: 'host_observation_error';
  readonly message: string;
};
