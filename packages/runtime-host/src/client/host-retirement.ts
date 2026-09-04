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

import type { OperationOutput } from '../protocol/index.js';
import type { RuntimeHostConnection } from './connection.js';

export type RuntimeHostRetirementMode = 'refuse_active_work' | 'interrupt_active_work';
export type RuntimeHostRetirementPreparation = OperationOutput<'host.upgrade.prepare'>;

/**
 * Requests retirement of the exact authenticated Host behind `connection`.
 *
 * `host.upgrade.prepare` is the current wire identifier. Keep that historical
 * transport detail here so lifecycle owners can model the operation as
 * retirement instead of spreading update-specific authority.
 */
export function prepareConnectedRuntimeHostRetirement(
  connection: RuntimeHostConnection,
  mode: RuntimeHostRetirementMode,
  timeoutMs?: number,
): Promise<RuntimeHostRetirementPreparation> {
  return connection.request(
    'host.upgrade.prepare',
    {
      expectedHostEpoch: connection.hostEpoch,
      allowInterruptActiveTasks: mode === 'interrupt_active_work',
    },
    timeoutMs,
  );
}
