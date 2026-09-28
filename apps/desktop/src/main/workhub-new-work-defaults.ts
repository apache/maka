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

import type { WorkHubCreateDefaults } from '@maka/core/session';

type WorkHubExecutionDefaults = Omit<WorkHubCreateDefaults, 'permissionMode'>;

// A transport reconnect replaces the client object but preserves the logical
// Host identity. Keep this Desktop-owned preference on that stable boundary so
// the renderer and the WorkHub creation path cannot disagree after reconnect.
// This remains process-local by design: persisting a user preference across
// app restarts is a separate product decision.
const defaultsByHost = new Map<string, WorkHubExecutionDefaults>();

export function readWorkHubNewWorkDefaults(hostId: string): WorkHubExecutionDefaults {
  return defaultsByHost.get(hostId) ?? {};
}

export function writeWorkHubNewWorkDefaults(
  hostId: string,
  defaults: WorkHubExecutionDefaults,
): void {
  defaultsByHost.set(hostId, Object.freeze({ ...defaults }));
}
