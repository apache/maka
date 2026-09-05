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

import {
  desktopSessionKey,
  type DesktopTargetScope,
} from '../shared/runtime-host-identity.js';

export interface ResolvedRuntimeHostSession {
  readonly scope: DesktopTargetScope;
  readonly sessionId: string;
}

export type RuntimeHostSessionResolver = (
  sessionId: string,
) => Promise<ResolvedRuntimeHostSession>;

export type ScopedSessionInvoker = (
  channel: string,
  scope: DesktopTargetScope,
  sessionId: string,
  ...args: unknown[]
) => Promise<unknown>;

const SESSION_ID_FIELDS = new Set([
  'sessionId',
  'rootSessionId',
  'childSessionId',
  'sourceSessionId',
  'ownerSessionId',
]);

// Closed client models may be projected structurally. Opaque tool/provider data
// must use a typed projection so user content is never rewritten.
export function projectProtocolSessionIds<T>(hostId: string, value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => projectProtocolSessionIds(hostId, entry)) as T;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SESSION_ID_FIELDS.has(key) && typeof entry === 'string'
        ? desktopSessionKey({ hostId, sessionId: entry })
        : projectProtocolSessionIds(hostId, entry),
    ]),
  ) as T;
}

export async function invokeProjectedSessionRuntimeHost<T>(
  resolveSession: RuntimeHostSessionResolver,
  invoke: ScopedSessionInvoker,
  channel: string,
  sessionId: string,
  ...args: unknown[]
): Promise<T> {
  const session = await resolveSession(sessionId);
  const value = await invoke(channel, session.scope, session.sessionId, ...args) as T;
  return projectProtocolSessionIds(session.scope.hostId, value);
}
