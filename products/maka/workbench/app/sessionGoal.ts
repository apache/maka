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
  AgentGoalView,
  AgentGoalApproval,
  AgentGoalResult,
  ModelSelection,
  ThinkingLevel,
} from '../../../../packages/plugin-sdk/src/index.js';
import type { ComposerGoal } from '../../../../packages/plugin-sdk/src/composer-view.js';
import type { Control } from '../../../../plugins/agent/conversations/ui/Conversation';
import type { Subscription } from './history';
import type { Host } from './host';
import type { SessionPermissions } from './sessionPermissions';
import type { MessageKey } from './locale';
import { createText, errorText, UiError } from './text';

export function goalRejection(reason: string): MessageKey {
  const reasons: Record<string, MessageKey> = {
    goal_current_unfinished: 'Finish or cancel the current Goal before starting another.',
    goal_incognito: 'Turn off incognito to start a Goal.',
    goal_disabled: 'Goals are unavailable in this Agent.',
    scheduler_authorization_changed: 'Conversation settings changed. Try again.',
    goal_status_tool_unavailable: 'Enable Goal tools for this conversation to start a Goal.',
  };

  return reasons[reason] ?? 'This action could not be completed.';
}

export function createSessionGoal(
  host: Host,
  sessionId: string,
  control: Control,
  permissions: SessionPermissions,
  selection: () => Promise<{
    model: ModelSelection;
    thinkingLevel: ThinkingLevel | null;
  } | null>,
): ComposerGoal {
  const view = signal<AgentGoalView | null>(null);
  const pending = signal(false);
  const error = createText();
  const connectionError = createText();
  let alive = true;
  let stream: Subscription | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  cleanup(() => {
    alive = false;
    if (retry !== null) clearTimeout(retry);
    void stream?.close().catch(() => {});
  });
  const watch = async () => {
    try {
      const opened = await host.subscribe('agent', 'watchGoal', { sessionId });
      if (!alive) {
        await opened.close();
        return;
      }
      stream = opened;
      try {
        while (alive) {
          const next: AgentGoalView | null = await opened.next();
          if (!alive) return;
          if (next === null) throw new UiError('Goal updates disconnected. Reconnecting…');
          batch(() => {
            view.set(next);
            connectionError.set('');
          });
        }
      } finally {
        if (stream === opened) stream = null;
        await opened.close();
      }
    } catch (reason) {
      if (alive) {
        connectionError.set(errorText(reason));
        retry = setTimeout(() => {
          retry = null;
          void watch();
        }, 1000);
      }
    }
  };
  void watch();
  const approval = async (): Promise<AgentGoalApproval | null> => {
    const chosen = await selection();
    if (!chosen) return null;
    const session = permissions.snapshot();
    if (!session) throw new UiError('Loading sandbox settings…');
    return {
      target: {
        sessionId,
        workspace: session.workspace,
        permissions: session.permissions,
        boundaryRevision: session.boundaryRevision,
        binding: session.binding,
      },
      ...chosen,
    };
  };
  const change = async (input: () => Promise<object | null>) => {
    if (!alive || pending()) return false;
    pending.set(true);
    error.set('');
    try {
      const request = await input();
      if (!request || !alive) return false;
      const result: AgentGoalResult = await control('changeGoal', {
        sessionId,
        ...request,
      });
      if (!alive) return false;
      if (result.kind === 'conflict')
        throw new UiError('The Goal changed. Review it and try again.');
      if (result.kind === 'rejected') {
        throw new UiError(goalRejection(result.reason));
      }
      const next: AgentGoalView = await host.query('agent', 'goal', { sessionId });
      if (!alive) return false;
      view.set(next);
      return true;
    } catch (reason) {
      if (alive) error.set(errorText(reason));
      return false;
    } finally {
      if (alive) pending.set(false);
    }
  };
  return {
    view,
    pending,
    error: () => error() || connectionError(),
    create: (objective, tokenBudget) =>
      change(async () => {
        const granted = await approval();
        return granted
          ? {
              kind: 'create',
              objective,
              tokenBudget,
              start: true,
              approval: granted,
            }
          : null;
      }),
    change: (action, budget) =>
      change(async () => {
        const current = view()?.current;
        if (!current) return null;
        const granted = action === 'resume' && !current.pending ? await approval() : null;
        return {
          kind: 'control',
          goalId: current.id,
          revision: current.revision,
          action,
          ...(budget ? { budget } : {}),
          ...(granted ? { approval: granted } : {}),
        };
      }),
  };
}
