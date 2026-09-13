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

import type { ExecutionBoundaryReadModel } from '@maka/core/sandbox-boundary';
import type { PermissionMode } from '@maka/core/permission';
import { executionBoundaryDisplayMode } from '@maka/core/sandbox-boundary';

export interface DesktopExecutionBoundarySurface {
  permissionMode: PermissionMode | undefined;
  localInteractionAvailable: boolean;
}

export function deriveDesktopExecutionBoundarySurface(
  activeSessionId: string | undefined,
  boundary: ExecutionBoundaryReadModel | undefined,
  fallbackMode: PermissionMode,
): DesktopExecutionBoundarySurface {
  if (!activeSessionId) {
    return {
      permissionMode: fallbackMode,
      localInteractionAvailable: true,
    };
  }
  // #1611: the boundary is the authority on what the session may do, and
  // `executionBoundaryDisplayMode` is the single place that maps it to a mode
  // the user sees — shared with the TUI so the two surfaces cannot drift.
  // Until it resolves (and permanently, for an externally isolated session)
  // this surface fails closed: no mode, no local controls.
  const permissionMode = boundary ? executionBoundaryDisplayMode(boundary) : undefined;
  return permissionMode
    ? { permissionMode, localInteractionAvailable: true }
    : { permissionMode: undefined, localInteractionAvailable: false };
}
