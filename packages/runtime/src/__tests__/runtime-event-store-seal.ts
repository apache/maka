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

import { isTerminalRuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { RunSealedError } from '@maka/core/runtime-event-store';

/**
 * The seal every `RuntimeEventStore` owes its callers, for the doubles.
 *
 * `RuntimeEventStore` requires an implementation to refuse any new event on a
 * run that already holds a terminal one. A double that skips it manufactures a
 * ledger no supported store can produce, and a test built on that ledger proves
 * nothing about production. Stated here once so the doubles cannot drift apart
 * from each other or from the SQLite store.
 *
 * A test that genuinely needs a corrupt ledger should assemble it underneath the
 * store rather than appending through it.
 */
export function assertDoubleRunNotSealed(
  storedEvents: readonly RuntimeEvent[],
  incoming: RuntimeEvent,
): void {
  // An exact-id replay is idempotent: the event is already inside the seal.
  if (storedEvents.some((event) => event.id === incoming.id)) return;
  if (storedEvents.some(isTerminalRuntimeEvent)) throw new RunSealedError(incoming.runId);
}
