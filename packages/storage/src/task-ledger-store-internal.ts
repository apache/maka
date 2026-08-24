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

import type { Task, TaskLedgerListOptions, TaskLedgerStore } from '@maka/core/task-ledger';

export interface TaskLedgerCanonicalReader {
  list(sessionId: string, options?: TaskLedgerListOptions): Promise<Task[]>;
  get(sessionId: string, id: string, options?: TaskLedgerListOptions): Promise<Task | undefined>;
}

// Package-private bridge: this module must stay outside both the root barrel and package exports.
const canonicalReaderByStore = new WeakMap<object, TaskLedgerCanonicalReader>();

export function registerTaskLedgerCanonicalReader(
  store: TaskLedgerStore,
  reader: TaskLedgerCanonicalReader,
): void {
  if (canonicalReaderByStore.has(store)) {
    throw new Error('Task ledger store already has a canonical reader');
  }
  canonicalReaderByStore.set(store, Object.freeze(reader));
}

export function getTaskLedgerCanonicalReader(store: TaskLedgerStore): TaskLedgerCanonicalReader {
  const reader = canonicalReaderByStore.get(store);
  if (!reader) throw new Error('Task ledger store is missing its internal canonical reader');
  return reader;
}
