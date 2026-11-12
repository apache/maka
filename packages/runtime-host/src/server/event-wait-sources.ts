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

import type { AnyEventWaitRecord } from '@maka/core/event-wait';
import type { EventWaitAdapterRegistry, EventWaitObservationAccess } from './event-wait-adapter.js';
import type { EventWaitClock, EventWaitObservationPolicy } from './event-wait-manager.js';

export interface HostEventWaitSources {
  readonly adapters: EventWaitAdapterRegistry;
  /** Trusted source policy. A model request never supplies this capability. */
  readonly authorize: (
    wait: AnyEventWaitRecord,
    signal: AbortSignal,
  ) => Promise<EventWaitObservationAccess>;
  readonly clock?: EventWaitClock;
  readonly policy?: Partial<EventWaitObservationPolicy>;
}
