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

import type { SessionHeader } from '@maka/core/session';

export interface SandboxBoundaryGraphWakeHeaderReader {
  readHeaderSnapshot(sessionId: string): Promise<Pick<SessionHeader, 'id' | 'subagentParent'>>;
}

/** Resolve the root Session whose parked graph wake a boundary answer can release. */
export async function sandboxBoundaryGraphWakeRoot(
  header: Pick<SessionHeader, 'id' | 'subagentParent'>,
  graphIds: { listGraphIds(rootSessionId: string): Promise<readonly string[]> },
): Promise<string | undefined> {
  const parent = header.subagentParent;
  if (!parent) return header.id;
  if (!parent.graph) return undefined;
  if (!(await graphIds.listGraphIds(parent.parentSessionId)).includes(parent.graph.graphId)) {
    throw new Error(
      `Graph operator Session ${header.id} does not match root Session ${parent.parentSessionId}`,
    );
  }
  return parent.parentSessionId;
}

/** Resolve durable lineage before notifying the root graph supervisor. */
export async function notifySandboxBoundaryGraphWake(
  sessionId: string,
  sessions: SandboxBoundaryGraphWakeHeaderReader,
  graphIds: { listGraphIds(rootSessionId: string): Promise<readonly string[]> },
  notifyPermissionResponse: (rootSessionId: string) => Promise<void> | void,
): Promise<void> {
  const header = await sessions.readHeaderSnapshot(sessionId);
  const rootSessionId = await sandboxBoundaryGraphWakeRoot(header, graphIds);
  if (rootSessionId) await notifyPermissionResponse(rootSessionId);
}
