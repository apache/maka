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

import { cleanup, signal } from 'nsh';
import type {
  AgentMetadata,
  AgentMetadataResult,
  AgentSession,
  AgentWorkspacePermissions,
} from '../../../../packages/plugin-sdk/src/index.js';
import type { Control } from './Conversation';
import { host } from './host';
import { createText, errorText, message, UiError } from './text';

export type PermissionSelection = {
  session: AgentSession;
  settings: AgentWorkspacePermissions;
};
export type SessionPermissions = ReturnType<typeof createSessionPermissions>;

export function createSessionPermissions(sessionId: string, control: Control) {
  const snapshot = signal<AgentSession | null>(null);
  const pending = signal(false);
  const error = createText();
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const observe = (session: AgentSession) => {
    // A read started before a committed mutation cannot restore its old policy.
    if (alive && session.revision >= (snapshot()?.revision ?? -1)) snapshot.set(session);
  };
  const select = async ({ session, settings }: PermissionSelection) => {
    if (
      !alive ||
      pending() ||
      session.id !== sessionId ||
      session.revision !== snapshot()?.revision
    )
      return;
    error.set('');
    if (
      settings.access === session.permissions.access &&
      settings.requestPermissions === session.permissions.requestPermissions
    )
      return;
    const input: AgentMetadata = {
      sessionId,
      expectedRevision: session.revision,
      title: session.title,
      labels: [...session.labels],
      permissions: { settings, revokeGrants: true },
    };
    pending.set(true);
    try {
      // Keep the existing durable control journal and its unknown-outcome guard.
      const result: AgentMetadataResult = await control('metadata', input);
      if (!alive) return;
      if (result.kind === 'committed') observe(result.session);
      else if (result.kind === 'rejected')
        throw new UiError('Sandbox settings rejected: {reason}', { reason: result.reason });
      else {
        const conflict = message(
          'This conversation changed. Review its current sandbox settings, then choose again.',
        );
        error.set(conflict);
        try {
          const current = await host.query('agent', 'observe', { sessionId });
          if (alive) observe(current.session);
        } catch (reason) {
          if (alive)
            error.set(
              message('{message} {detail}', { message: conflict, detail: errorText(reason) }),
            );
        }
      }
    } catch (reason) {
      if (alive) error.set(errorText(reason));
    } finally {
      if (alive) pending.set(false);
    }
  };
  return { sessionId, snapshot, pending, error, observe, select };
}
