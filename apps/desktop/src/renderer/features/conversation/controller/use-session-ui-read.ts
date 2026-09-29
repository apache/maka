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

import { useMemo, useSyncExternalStore } from 'react';
import type { SnapshotReader } from '../../../application/contracts/snapshot-reader.js';
import type { SessionUiReadKind, SessionUiReads } from '../model/session-ui-reads.js';

type SessionUiReading<K extends SessionUiReadKind> = ReturnType<ReturnType<SessionUiReads[K]>['getSnapshot']>;

/** The target participates in memoization, so a new target reads fresh immediately. */
export function useSessionUiRead<K extends SessionUiReadKind>(
  reads: SessionUiReads,
  kind: K,
  sessionId: string | undefined,
): SessionUiReading<K> {
  const reader = useMemo(
    () => reads[kind](sessionId) as SnapshotReader<SessionUiReading<K>>,
    [reads, kind, sessionId],
  );
  return useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
}
