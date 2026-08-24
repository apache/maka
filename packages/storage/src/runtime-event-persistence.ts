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

import { join } from 'node:path';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { BoundedEvidenceReadResult, EvidenceReadBudget } from './agent-run-store.js';
import { createSqliteRuntimeStore, type SqliteRuntimeStore } from './sqlite-runtime-store.js';
import {
  acquireOperationalStateDatabase,
  OPERATIONAL_STATE_DATABASE_NAME,
} from './operational-state-store.js';

export type RuntimeEventPersistence = {
  kind: 'sqlite';
  runtimeEventStore: SqliteRuntimeStore;
  runtimeCommitStore: SqliteRuntimeStore;
  close(): void;
};

export type RuntimeEventReadPersistence = {
  kind: 'sqlite';
  runtimeEventStore: RuntimeEventReadStore;
  close(): void;
};

export interface RuntimeEventReadStore {
  readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
  readRuntimeEventsBounded(
    sessionId: string,
    runId: string,
    budget: EvidenceReadBudget,
  ): Promise<BoundedEvidenceReadResult<RuntimeEvent>>;
  readImmutableRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
  readSessionRuntimeEvents(sessionId: string): Promise<RuntimeEvent[]>;
}

export async function openRuntimeEventPersistence(input: {
  workspaceRoot: string;
}): Promise<RuntimeEventPersistence> {
  const store = createWorkspaceRuntimeStore(input.workspaceRoot);
  return {
    kind: 'sqlite',
    runtimeEventStore: store,
    runtimeCommitStore: store,
    close: () => store.close(),
  };
}

export function createWorkspaceRuntimeStore(workspaceRoot: string): SqliteRuntimeStore {
  const databaseLease = acquireOperationalStateDatabase(workspaceRoot);
  return createSqliteRuntimeStore(join(workspaceRoot, OPERATIONAL_STATE_DATABASE_NAME), {
    databaseLease,
  });
}

export async function openRuntimeEventReadPersistence(input: {
  workspaceRoot: string;
}): Promise<RuntimeEventReadPersistence> {
  const store = createSqliteRuntimeStore(
    join(input.workspaceRoot, OPERATIONAL_STATE_DATABASE_NAME),
    { readOnly: true },
  );
  return {
    kind: 'sqlite',
    runtimeEventStore: Object.freeze({
      readRuntimeEvents: (sessionId: string, runId: string) =>
        store.readRuntimeEvents(sessionId, runId),
      readRuntimeEventsBounded: (sessionId: string, runId: string, budget: EvidenceReadBudget) =>
        store.readRuntimeEventsBounded(sessionId, runId, budget),
      readImmutableRuntimeEvents: (sessionId: string, runId: string) =>
        store.readImmutableRuntimeEvents(sessionId, runId),
      readSessionRuntimeEvents: (sessionId: string) => store.readSessionRuntimeEvents(sessionId),
    }),
    close: () => store.close(),
  };
}
