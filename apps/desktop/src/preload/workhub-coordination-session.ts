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

import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import {
  desktopSessionKey,
  type DesktopTargetScope,
} from '../shared/runtime-host-identity.js';

export async function resolveDesktopWorkHubCoordinationSession(
  activeRuntimeHost: () => Promise<DesktopTargetScope>,
  resolveOnHost: (
    scope: DesktopTargetScope,
  ) => Promise<{ readonly sessionId: string }>,
): Promise<string> {
  const scope = await activeRuntimeHost();
  const result = await resolveOnHost(scope);
  return desktopSessionKey({ hostId: scope.hostId, sessionId: result.sessionId });
}

/** Resolves an exact Host scope from the durable Coordination identity, never from UI focus. */
export async function resolveDesktopWorkHubCoordinationCreateScope(
  coordinationSessionId: string,
  resolveSession: (
    sessionId: string,
  ) => Promise<{ readonly scope: DesktopTargetScope; readonly sessionId: string }>,
): Promise<DesktopTargetScope> {
  const coordination = await resolveSession(coordinationSessionId);
  if (coordination.sessionId !== WORKHUB_COORDINATION_SESSION_ID) {
    throw new Error('Invalid WorkHub Coordination Session identity');
  }
  return coordination.scope;
}
