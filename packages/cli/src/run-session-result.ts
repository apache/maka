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
  InteractionQuestion,
  InteractionSandboxBoundaryRequest,
} from '@maka/core/interaction';
import type { InteractionPendingSnapshot, TurnProviderRetry } from '@maka/runtime-host/protocol';
import type { ExecutionBoundarySummary } from '@maka/core/sandbox-boundary';

export interface MakaRunSessionResult {
  sessionId: string;
  status: 'running' | 'needs_input' | 'needs_approval' | 'completed' | 'failed' | 'idle';
  finalOutput?: string;
  error?: string;
  questions?: readonly InteractionQuestion[];
  pendingQuestionCount?: number;
  approvalRequests?: readonly InteractionSandboxBoundaryRequest[];
  queued?: number;
  submission?: 'started' | 'queued' | 'steering' | 'inbox';
  executionBoundary?: ExecutionBoundarySummary;
  providerRetry?: TurnProviderRetry;
}

/** A normal handoff to the caller, not a failed or cancelled Host Turn. */
export class RunQuestionAvailable extends Error {
  constructor(readonly pending: InteractionPendingSnapshot) {
    super('The Turn is waiting for an answer');
  }

  result(): MakaRunSessionResult {
    return {
      sessionId: this.pending.sessionId,
      status: 'needs_input',
      questions: this.pending.request.kind === 'question' ? this.pending.request.questions : [],
    };
  }
}

export class RunSessionInterrupted extends Error {
  constructor() {
    super('Session observation interrupted; Host execution was not stopped');
  }
}
