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
import type { SessionTrace } from '@maka/core/session-trace';
import type { Result } from '@maka/core/result';
import type { ContextDiagnosticsResult } from '@maka/runtime-host/protocol';
import type { MergedUsageSummary } from '@maka/core/usage-ledger-merge';

export interface SessionTracePage {
  readonly trace: SessionTrace;
  readonly nextCursor: string | null;
}

export type SessionUsageSummary = MergedUsageSummary;

export interface SessionInspectorService {
  trace(
    sessionId: string,
    cursor?: string,
  ): Promise<Result<SessionTracePage>>;
  summary(sessionId: string): Promise<Result<SessionUsageSummary>>;
  context(sessionId: string): Promise<Result<ContextDiagnosticsResult>>;
  subscribeSessionEvents(
    sessionId: string,
    handler: (event: SessionEvent) => void,
  ): () => void;
  subscribeUsageChanges(
    sessionId: string,
    handler: () => void,
  ): () => void;
}

