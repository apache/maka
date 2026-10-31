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
  AgentRejection,
  AgentSession,
  AgentWorkspacePermissions,
  CollaborationMode,
} from '../../../../packages/plugin-sdk/src/index.js';
import type { Control } from '../../../../plugins/agent/conversations/ui/Conversation';
import type { Host } from './host';
import { createText, errorText, message, UiError } from './text';

export type PermissionSelection = {
  session: AgentSession;
  settings: AgentWorkspacePermissions;
};
export type SessionPermissions = ReturnType<typeof createSessionPermissions>;

export function createSessionPermissions(host: Host, sessionId: string, control: Control) {
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
  // Both changes go through `metadata`: the conflict and rejection handling is shared.
  const commit = async (
    session: AgentSession,
    change: Pick<AgentMetadata, 'permissions' | 'collaborationMode'>,
    rejected: (reason: AgentRejection) => UiError,
  ): Promise<AgentSession | null> => {
    const input: AgentMetadata = {
      sessionId,
      expectedRevision: session.revision,
      title: session.title,
      labels: [...session.labels],
      ...change,
    };
    pending.set(true);
    try {
      // Keep the existing durable control journal and its unknown-outcome guard.
      const result: AgentMetadataResult = await control('metadata', input);
      if (!alive) return null;
      if (result.kind === 'committed') {
        observe(result.session);
        return result.session;
      }
      if (result.kind === 'rejected') throw rejected(result.reason);
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
      return null;
    } catch (reason) {
      if (alive) error.set(errorText(reason));
      return null;
    } finally {
      if (alive) pending.set(false);
    }
  };
  const current = (session: AgentSession) =>
    alive && !pending() && session.id === sessionId && session.revision === snapshot()?.revision;
  const select = async ({ session, settings }: PermissionSelection) => {
    if (!current(session)) return;
    error.set('');
    if (
      settings.access === session.permissions.access &&
      settings.requestPermissions === session.permissions.requestPermissions
    )
      return;
    await commit(
      session,
      { permissions: { settings, revokeGrants: true } },
      (reason) => new UiError('Sandbox settings rejected: {reason}', { reason }),
    );
  };
  /** Resolves to the committed Session, or null when nothing changed. */
  const selectMode = async ({
    session,
    mode,
  }: {
    session: AgentSession;
    mode: CollaborationMode;
  }) => {
    if (!current(session)) return null;
    error.set('');
    if ((session.collaborationMode ?? 'agent') === mode) return session;
    return commit(session, { collaborationMode: mode }, (reason) =>
      reason === 'busy'
        ? new UiError(
            'Wait for the current execution and queued messages to finish before switching mode.',
          )
        : new UiError(
            mode === 'plan'
              ? 'Planning mode could not start: {reason}'
              : 'Planning mode could not end: {reason}',
            { reason },
          ),
    );
  };
  return { sessionId, snapshot, pending, error, observe, select, selectMode };
}
