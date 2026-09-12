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

import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import type { StoredMessage } from '@maka/core/session';
import type { ExecutionRuntimeEventReader } from '@maka/storage/execution-stores';
import { RuntimeReadModel } from '@maka/runtime/runtime-read-model';

/**
 * A Session's transcript as the ledger tells it, for tests that used to read
 * `session_messages` directly. This is the read model itself, without a
 * SessionManager to host it — so ordering, inline-invocation scope and running
 * turns read exactly as the product presents them.
 */
export async function readLedgerMessages(
  runtimeEventStore: Readonly<ExecutionRuntimeEventReader>,
  sessionId: string,
): Promise<readonly StoredMessage[]> {
  // The read model only reads; the reader fragment carries every method it uses.
  const store = runtimeEventStore as unknown as RuntimeEventStore;
  return (await new RuntimeReadModel({ runtimeEventStore: store }).getSessionView(sessionId))
    .messages;
}
