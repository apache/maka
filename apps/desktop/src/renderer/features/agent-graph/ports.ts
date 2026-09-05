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
  AgentGraphClientSnapshot,
  AgentGraphClientSnapshotOptions,
  AgentGraphOperatorInspection,
} from '@maka/runtime/stream-graph-read-model';
import type { AgentGraphEpochSummary } from '@maka/runtime-host/protocol';

export interface AgentGraphEpochDirectory {
  readonly epochs: readonly AgentGraphEpochSummary[];
  readonly truncated: boolean;
}

export interface AgentGraphService {
  listEpochs(rootSessionId: string): Promise<AgentGraphEpochDirectory>;
  listCurrentEpochs(rootSessionId: string): Promise<AgentGraphEpochDirectory>;
  getSnapshot(
    rootSessionId: string,
    options?: AgentGraphClientSnapshotOptions & { graphId?: string },
  ): Promise<AgentGraphClientSnapshot>;
  inspectOperator(
    rootSessionId: string,
    operatorId: string,
    graphId?: string,
  ): Promise<AgentGraphOperatorInspection>;
  stop(rootSessionId: string, expectedGraphId: string): Promise<void>;
  subscribe(rootSessionId: string, handler: () => void): () => void;
}

export interface AgentGraphServices {
  readonly graphs: AgentGraphService;
}
