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

import { WORKSPACE_AUTHORITY_SESSION_ID } from '@maka/core/workspace-version-authority';

import { type RuntimeEvent } from '@maka/core/runtime-event';

/**
 * Generic and non-workspace writers must never create workspace authority
 * facts or occupy the store-owned authority stream. SQLite's dedicated
 * baseline writer is the only caller that may cross this boundary.
 */
export function assertNoReservedWorkspaceAuthorityAppend(event: RuntimeEvent): void {
  if (event.actions?.workspaceFact !== undefined) {
    throw new Error('Workspace facts require the atomic workspace version authority writer');
  }
  if (event.sessionId === WORKSPACE_AUTHORITY_SESSION_ID) {
    throw new Error('RuntimeEvent targets the reserved workspace authority stream');
  }
}
