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
import { batch, cleanup, signal } from 'nsh';
import type {
  AgentPlanAction,
  AgentPlanApproval,
  AgentPlanResult,
  AgentPlanView,
  CollaborationMode,
  ModelSelection,
  ThinkingLevel,
} from '../../../../packages/plugin-sdk/src/index.js';
import type {
  ComposerPlan,
  ComposerPlanAction,
} from '../../../../packages/plugin-sdk/src/composer-view.js';
import type { Control } from '../../../../plugins/agent/conversations/ui/Conversation';
import type { Subscription } from './history';
import type { Host } from './host';
import type { MessageKey } from './locale';
import type { SessionPermissions } from './sessionPermissions';
import { createText, errorText, message, UiError } from './text';

// Reasons the Host gives that the user can act on; others are shown as they are.
const rejections: Record<string, MessageKey> = {
  plan_disabled: 'Plans are unavailable in this Agent.',
  plan_incognito: 'Plans cannot run while incognito is on.',
  plan_approval_session_changed: 'The Plan or conversation changed. Review it again.',
  scheduler_authorization_changed: 'The Plan or conversation changed. Review it again.',
  graph_background_conflict: 'This conversation is running other work. Try again once it is idle.',
  plan_progress_tool_unavailable:
    "This conversation's tools leave out plan progress, so the plan cannot run.",
  plan_resume_session_first: 'Continue the paused response before resuming the plan.',
};

export function createSessionPlan(
  host: Host,
  sessionId: string,
  control: Control,
  permissions: SessionPermissions,
  selection: () => Promise<{ model: ModelSelection; thinkingLevel: ThinkingLevel | null } | null>,
): ComposerPlan {
  const view = signal<AgentPlanView | null>(null);
  const pending = signal(false);
  const error = createText();
  let alive = true;
  let stream: Subscription | null = null;
  cleanup(() => {
    alive = false;
    const previous = stream;
    stream = null;
    if (previous) void previous.close().catch(() => {});
  });
  void (async () => {
    const opened = await host.subscribe('agent', 'watchPlan', { sessionId });
    if (!alive) {
      await opened.close();
      return;
    }
    stream = opened;
    try {
      for (;;) {
        const next: AgentPlanView | null = await opened.next();
        if (!alive) return;
        if (next === null) throw new UiError('Plan updates ended. Reopen the conversation.');
        if (next.current.revision < (view()?.current.revision ?? -1)) continue;
        batch(() => {
          view.set(next);
          error.set('');
        });
      }
    } finally {
      if (stream === opened) {
        stream = null;
        await opened.close();
      }
    }
  })().catch((reason) => {
    if (alive) error.set(errorText(reason));
  });

  // The Host runs an approved Plan as agent work in the background whatever
  // mode the conversation is in, so approving leaves the mode as it is.
  const approval = async (): Promise<AgentPlanApproval | null> => {
    const session = permissions.snapshot();
    if (!session) throw new UiError('Loading sandbox settings…');
    const chosen = await selection();
    if (!chosen) return null;
    return {
      target: {
        sessionId,
        workspace: session.workspace,
        permissions: session.permissions,
        boundaryRevision: session.boundaryRevision,
        binding: session.binding,
      },
      model: chosen.model,
      thinkingLevel: chosen.thinkingLevel,
    };
  };
  const change = async (action: ComposerPlanAction) => {
    const current = view();
    if (!alive || pending() || !current) return;
    error.set('');
    pending.set(true);
    try {
      let planAction: AgentPlanAction;
      if (action.kind === 'approve' || action.kind === 'resume') {
        const granted = await approval();
        if (!granted || !alive) return;
        planAction =
          action.kind === 'approve'
            ? { ...action, approval: granted }
            : { kind: 'resume', executionId: action.executionId, approval: granted };
      } else if (action.kind === 'revise') {
        // Only planning mode lets the model submit the revised Plan.
        const session = permissions.snapshot();
        if (!session) throw new UiError('Loading sandbox settings…');
        if (!(await permissions.selectMode({ session, mode: 'plan' })) || !alive) return;
        planAction = action;
      } else if (action.kind === 'cancel') {
        planAction = { kind: 'cancel', executionId: action.executionId, reason: 'user_cancelled' };
      } else {
        planAction = action;
      }
      const result: AgentPlanResult = await control('changePlan', {
        sessionId,
        revision: current.current.revision,
        action: planAction,
      });
      if (!alive) return;
      if (result.kind === 'conflict')
        error.set(message('The Plan or conversation changed. Review it again.'));
      else if (result.kind === 'rejected') {
        const known = rejections[result.reason];
        error.set(
          known
            ? message(known)
            : message('Plan action rejected: {reason}', { reason: result.reason }),
        );
      }
    } catch (reason) {
      if (alive) error.set(errorText(reason));
    } finally {
      if (alive) pending.set(false);
    }
  };
  const selectMode = async (mode: CollaborationMode) => {
    const session = permissions.snapshot();
    if (!alive || pending() || !session) return;
    error.set('');
    try {
      await permissions.selectMode({ session, mode });
    } catch (reason) {
      if (alive) error.set(errorText(reason));
    }
  };
  return {
    view,
    mode: () => {
      const session = permissions.snapshot();
      return session ? (session.collaborationMode ?? 'agent') : null;
    },
    pending: () => pending() || permissions.pending(),
    error,
    selectMode,
    change,
  };
}
