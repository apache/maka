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

import { UiError } from './text';
import { tr } from './locale';
import type { AgentSession, AgentForkPosition } from '../../../../packages/plugin-sdk/src/index.js';
import type { Control } from '../../../../plugins/agent/conversations/ui/Conversation';

export type SessionActionTarget = Pick<
  AgentSession,
  'id' | 'revision' | 'title' | 'labels' | 'archived' | 'pinned'
> & {
  workspace: Pick<AgentSession['workspace'], 'path'>;
};
// Catalog activity is presentation data; it must not rebind a metadata action.
export function sessionActionTarget(session: AgentSession): SessionActionTarget {
  return {
    id: session.id,
    revision: session.revision,
    title: session.title,
    labels: [...session.labels],
    archived: session.archived,
    pinned: session.pinned,
    workspace: { path: session.workspace.path },
  };
}

export type SessionAction =
  | { kind: 'rename'; session: SessionActionTarget; title: string }
  | { kind: 'fork'; session: SessionActionTarget; title: string; position: AgentForkPosition }
  | { kind: 'compaction_prompt'; session: SessionActionTarget; prompt: string | null }
  | { kind: 'archive' | 'restore' | 'remove' | 'pin' | 'unpin'; session: SessionActionTarget };
export type SessionActionResult =
  | { kind: 'updated' | 'forked'; session: AgentSession }
  | { kind: 'removed'; sessionId: string };

export class SessionRevisionConflict extends UiError {
  constructor() {
    super('This conversation changed. Review its current details, then try the action again.');
  }
}

// A prefix stays visible when the sidebar truncates the title, and forking a
// fork keeps a single prefix.
export const hasForkPrefix = (title: string) =>
  title.startsWith(tr('Fork · {title}', { title: '' }));
export const forkTitle = (title: string) => {
  const name = title || tr('Untitled conversation');
  return hasForkPrefix(name) ? name : tr('Fork · {title}', { title: name });
};

// The captured Session is the user's original revision and labels. A conflict
// requires another explicit action; never silently replace its CAS identity.
export async function performSessionAction(
  control: Control,
  action: SessionAction,
): Promise<SessionActionResult> {
  const session = action.session;
  const identity = { sessionId: session.id, expectedRevision: session.revision };
  const result =
    action.kind === 'rename' || action.kind === 'pin' || action.kind === 'unpin'
      ? await control('metadata', {
          ...identity,
          title: action.kind === 'rename' ? action.title : session.title,
          labels: [...session.labels],
          ...(action.kind === 'rename' ? {} : { pinned: action.kind === 'pin' }),
        })
      : action.kind === 'fork'
        ? await control('fork', {
            ...identity,
            position: action.position,
            title: action.title,
            labels: [...session.labels],
          })
        : action.kind === 'compaction_prompt'
          ? await control('setCompactionPrompt', { ...identity, prompt: action.prompt })
          : await control('changeSession', { ...identity, action: action.kind });
  if (result.kind === 'revision_conflict') throw new SessionRevisionConflict();
  if (result.kind === 'rejected') {
    const reason =
      action.kind === 'fork' && result.reason === 'history_unavailable'
        ? new UiError(
            'The Host cannot copy this history yet. Fork a completed turn, or wait for the current turn to finish.',
          )
        : action.kind === 'fork' && result.reason === 'managed_session'
          ? new UiError('WorkHub manages this conversation. Its history cannot be forked here.')
          : result.reason === 'busy'
            ? new UiError(
                'This conversation is working, has queued messages, or still needs your input. Finish it before changing its lifecycle.',
              )
            : new UiError('Conversation action rejected: {reason}', { reason: result.reason });
    throw reason;
  }
  if (result.kind === 'removed') return { kind: 'removed', sessionId: result.sessionId };
  if (result.kind === 'forked') return { kind: 'forked', session: result.session };
  if (result.kind === 'changed' || result.kind === 'committed')
    return { kind: 'updated', session: result.session };
  throw new UiError('Host returned an unexpected conversation action result.');
}
