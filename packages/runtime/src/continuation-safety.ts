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

import type { RuntimeContinuationSafetyObservation } from './runtime-resume.js';

export interface ResolvedWorkspaceIdentity {
  workspaceIdentity: string;
  canonicalPath: string;
}

export interface LocalContinuationSafetyInspectorDeps {
  readSessionCwd(sessionId: string): Promise<string>;
  resolveWorkspaceIdentity(cwd: string): Promise<ResolvedWorkspaceIdentity>;
  listAvailableToolNames(sessionId: string): Promise<readonly string[]>;
  hasPendingBackgroundOperations(sessionId: string): Promise<boolean>;
  readWorkspaceCheckpoint?: (
    sessionId: string,
  ) => Promise<RuntimeContinuationSafetyObservation['workspaceCheckpoint']>;
}

export function createLocalContinuationSafetyInspector(
  deps: LocalContinuationSafetyInspectorDeps,
): (sessionId: string) => Promise<RuntimeContinuationSafetyObservation> {
  return async (sessionId) => {
    const cwd = await deps.readSessionCwd(sessionId);
    const [workspace, availableToolNames, hasPendingBackgroundOperations, workspaceCheckpoint] =
      await Promise.all([
        deps.resolveWorkspaceIdentity(cwd),
        deps.listAvailableToolNames(sessionId),
        deps.hasPendingBackgroundOperations(sessionId),
        deps.readWorkspaceCheckpoint?.(sessionId),
      ]);
    return {
      workspaceIdentity: workspace.workspaceIdentity,
      workspacePath: workspace.canonicalPath,
      backgroundOperationsSettled: !hasPendingBackgroundOperations,
      availableToolNames: [...new Set(availableToolNames)].sort(),
      ...(workspaceCheckpoint ? { workspaceCheckpoint } : {}),
    };
  };
}
