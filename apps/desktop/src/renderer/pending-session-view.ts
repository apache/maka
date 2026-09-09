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

import type { PermissionMode } from '@maka/core/permission';
import type { SessionSummary } from '@maka/core/session';

export interface PendingSessionViewInput {
  sessionId: string;
  name: string;
  permissionMode: PermissionMode;
}

export interface RuntimeHostSessionProjection<T extends SessionSummary> {
  hostActiveId: string | undefined;
  hostActiveSession: T | undefined;
  ownerActiveId: string | undefined;
  sharedSessionActive: boolean;
}

/**
 * Projects the local catalog's active row onto the Runtime Host boundary.
 *
 * A pending row is already a real chat target locally, but the Runtime Host
 * has not accepted it yet. Host-only readers must therefore wait for the
 * authoritative catalog replacement instead of querying an id that cannot
 * exist there yet. Cached rows are deliberately retained: they represent a
 * previously accepted Host session whose readable local history may be shown
 * while the Host reconnects.
 */
export function projectRuntimeHostSession<
  T extends SessionSummary & {
    readonly localState?: 'pending' | 'cached';
    readonly shared?: true;
  },
>(session: T | undefined): RuntimeHostSessionProjection<T> {
  const sharedSessionActive = session?.shared === true;
  if (!session || session.localState === 'pending') {
    return {
      hostActiveId: undefined,
      hostActiveSession: undefined,
      ownerActiveId: undefined,
      sharedSessionActive,
    };
  }
  return {
    hostActiveId: session.id,
    hostActiveSession: session,
    ownerActiveId: sharedSessionActive ? undefined : session.id,
    sharedSessionActive,
  };
}

/**
 * The `SessionSummary` the chat view shows between "a session id became active"
 * and "its real summary arrived".
 *
 * The connection and model read empty because they are genuinely unknown: this
 * fallback covers every active id without a loaded summary, not just a freshly
 * created task, so the session behind it may be an existing one bound to any
 * model. An empty pair matches no offered choice, which is how the model
 * switcher's current-value and no-op comparisons read "not yet known" — naming
 * a plausible model instead would let a switch onto that model be silently
 * dropped as a no-op against a session that was never on it.
 *
 * It used to say `backend: 'fake'` / `model: 'fake-model'`, borrowing a retired
 * backend (#3211) to mean "not loaded". The unknown-ness is the same; the
 * borrowed name is gone.
 */
export function pendingSessionView(
  input: PendingSessionViewInput,
): SessionSummary & { readonly localState: 'pending' } {
  return {
    id: input.sessionId,
    name: input.name,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: '',
    connectionLocked: false,
    model: '',
    permissionMode: input.permissionMode,
    localState: 'pending',
  };
}
