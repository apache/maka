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

import type { SessionEvent } from '@maka/core/events';
import type { PlanSessionState } from '@maka/core/plan';
import type { PlanControlIpcResult } from '../../../shared/plan-mode-ipc.js';

/** Only the observation and control capabilities owned by the Plan panel. */
export interface PlanServices {
  getPlanState(sessionId: string): Promise<PlanSessionState>;
  subscribeEvents(sessionId: string, handler: (event: SessionEvent) => void): () => void;
  subscribePlanChanges(sessionId: string, handler: () => void): () => void;
  requestPlanRevision(sessionId: string, proposalId: string): Promise<PlanControlIpcResult<PlanSessionState>>;
  approvePlan(sessionId: string, input: {
    proposalId: string;
    expectedRevision: number;
    expectedStoreVersion: number;
    turnId: string;
  }): Promise<PlanControlIpcResult<{ turnId: string; executionId: string }>>;
  resumePlan(sessionId: string, executionId: string, turnId: string): Promise<PlanControlIpcResult<{ turnId: string; executionId: string }>>;
  abandonPlanExecution(sessionId: string, executionId: string): Promise<PlanControlIpcResult<PlanSessionState>>;
}
