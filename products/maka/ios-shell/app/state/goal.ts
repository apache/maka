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

import { batch, cleanup, computed, effect, lifecycle, signal } from 'nsh';
import {
  goalHost,
  MutationNotSubmitted,
  type ActiveHostInfo,
  type AgentGoalApproval,
  type AgentGoalChange,
  type AgentGoalDetail,
  type AgentGoalView,
  type GoalControl,
  type GoalStatus,
} from '../bridge';
import { trimHostWhitespace } from '../hostText';
import { tr, type MessageKey } from '../locale';
import { activeHostInfo } from './hostPool';
import { hapticNotification } from './preferences';

const statusKeys = {
  armed: 'Goal Ready',
  active: 'Goal in Progress',
  paused: 'Goal Paused',
  blocked: 'Goal Blocked',
  budget_limited: 'Goal Budget Limited',
  achieved: 'Goal Achieved',
  cancelled: 'Goal Cancelled',
} satisfies Record<GoalStatus, MessageKey>;

export const goalStatus = (status: GoalStatus) => tr(statusKeys[status]);
export const terminalGoal = (goal: AgentGoalDetail) =>
  goal.status === 'achieved' || goal.status === 'cancelled';

export function parseGoalBudget(raw: string): number | null | undefined {
  const text = raw.trim();
  if (!text) return null;
  const value = Number(text);
  return /^[0-9]+$/.test(text) && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function canResumeWithBudget(goal: AgentGoalDetail, budget: number | null) {
  return budget === null || (goal.consumed.missing === 0 && budget > goal.consumed.known);
}

type GoalCommand =
  | {
      action: 'create';
      expected: AgentGoalDetail | null;
      objective: string;
      tokenBudget: number | null;
    }
  | {
      action: Exclude<GoalControl, 'set_budget'>;
      expected: AgentGoalDetail;
      tokenBudget?: number | null;
    }
  | { action: 'set_budget'; expected: AgentGoalDetail; tokenBudget: number | null };

function allowed(command: GoalCommand, goal: AgentGoalDetail | null): boolean {
  if (command.action === 'create') {
    return (
      (!goal || (terminalGoal(goal) && !goal.pending)) && !!trimHostWhitespace(command.objective)
    );
  }
  if (!goal) return false;
  switch (command.action) {
    case 'pause':
      return goal.status === 'active';
    case 'resume':
      return goal.status === 'budget_limited'
        ? command.tokenBudget !== undefined && canResumeWithBudget(goal, command.tokenBudget)
        : goal.status === 'armed' || goal.status === 'paused' || goal.status === 'blocked';
    case 'complete':
      return !terminalGoal(goal) && !goal.pending;
    case 'cancel':
      return !terminalGoal(goal);
    case 'set_budget':
      return !terminalGoal(goal) && goal.status !== 'budget_limited';
    case 'dismiss':
      return terminalGoal(goal) && !goal.pending && !goal.dismissed;
  }
}

function goalRejection(reason: string) {
  switch (reason) {
    case 'goal_current_unfinished':
      return tr('Finish or cancel the current goal first.');
    case 'goal_disabled':
      return tr('Goals are turned off on this computer.');
    case 'goal_status_tool_unavailable':
      return tr('Enable Goal tools for this chat to start or resume a goal.');
    case 'scheduler_authorization_changed':
    case 'goal_authorization_changed':
      return tr('Chat settings changed. Review them and try again.');
    default:
      return tr('The computer rejected the goal change: {reason}', { reason });
  }
}

const changed = () => tr('The goal changed. Review it and try again.');

export type GoalController = ReturnType<typeof createGoalController>;

export function createGoalController(options: {
  rootId: string;
  sessionId: string;
  active: () => boolean;
  approval: (connection: ActiveHostInfo) => Promise<AgentGoalApproval | null>;
}) {
  const { rootId, sessionId } = options;
  const input = { sessionId };
  const connection = () => activeHostInfo(rootId);
  const generation = computed(() => {
    const conn = connection();
    return options.active() && lifecycle() === 'active' && conn?.endpoints.includes('agent')
      ? conn.generation
      : undefined;
  });
  const snapshot = signal<{ generation: number; view: AgentGoalView } | null>(null);
  const watchState = signal<'waiting' | 'live' | 'ended'>('waiting');
  const restartWatch = signal(0);
  const notice = signal<string | null>(null);
  const operation = signal<{ generation: number; through?: number } | null>(null);
  const view = () => snapshot()?.view ?? null;
  const current = () => view()?.current ?? null;
  const synced = () =>
    watchState() === 'live' &&
    generation() !== undefined &&
    snapshot()?.generation === generation();
  const busy = () => {
    const pending = operation();
    return (
      pending !== null &&
      (pending.through === undefined ||
        (snapshot()?.generation === pending.generation &&
          (current()?.revision ?? 0) < pending.through))
    );
  };
  const canReconnect = () => generation() !== undefined && watchState() === 'ended';
  const reconnectWatch = () => {
    if (canReconnect()) restartWatch.update((n) => n + 1);
  };
  const writable = () => synced() && view()?.enabled === true;
  const hasRecord = computed(() => !!current());
  const showEntry = computed(() => hasRecord() || writable());
  let alive = true;
  let watchEpoch = 0;
  cleanup(() => {
    alive = false;
  });

  function apply(gen: number, value: AgentGoalView) {
    const prev = snapshot();
    if (
      prev?.generation === gen &&
      (value.current?.revision ?? 0) < (prev.view.current?.revision ?? 0)
    )
      return false;
    snapshot.set({ generation: gen, view: value });
    return true;
  }

  effect(() => {
    const gen = generation();
    restartWatch();
    const epoch = ++watchEpoch;
    watchState.set('waiting');
    if (gen === undefined) return;
    const valid = () => alive && epoch === watchEpoch && gen === generation();
    const stop = goalHost.watch(
      rootId,
      gen,
      input,
      (value) => {
        if (!valid()) return;
        batch(() => {
          if (apply(gen, value)) watchState.set('live');
        });
      },
      (cause) => {
        if (!valid()) return;
        console.warn('Could not watch goal', cause);
        watchState.set('ended');
      },
    );
    cleanup(stop);
  });

  async function refresh(gen: number) {
    const epoch = watchEpoch;
    const before = snapshot();
    try {
      const value = await goalHost.read(rootId, gen, input);
      if (!alive || gen !== generation() || epoch !== watchEpoch) return;
      const latest = snapshot();
      // A query that raced a watch update cannot replace equally revised live usage.
      if (
        latest !== before &&
        latest?.generation === gen &&
        (value.current?.revision ?? 0) <= (latest.view.current?.revision ?? 0)
      )
        return;
      apply(gen, value);
    } catch (cause) {
      console.warn('Could not read goal', cause);
      if (alive && gen === generation() && epoch === watchEpoch && !notice())
        notice.set(tr('Could not refresh the goal.'));
    }
  }

  async function change(command: GoalCommand): Promise<boolean> {
    const conn = connection();
    if (!conn || !writable() || busy()) return false;
    const { generation: gen } = conn;
    const epoch = watchEpoch;
    const canSubmit = () => {
      const goal = current();
      return (
        alive &&
        watchEpoch === epoch &&
        generation() === gen &&
        writable() &&
        command.expected?.id === goal?.id &&
        command.expected?.revision === goal?.revision &&
        allowed(command, goal)
      );
    };
    if (!canSubmit()) {
      notice.set(changed());
      return false;
    }

    const flight = { generation: gen };
    operation.set(flight);
    notice.set(null);
    let submitted = false;
    try {
      const needsApproval =
        command.action === 'create' || (command.action === 'resume' && !command.expected.pending);
      const approval = needsApproval ? await options.approval(conn) : null;
      if (needsApproval && !approval) {
        if (alive)
          notice.set(tr('Could not verify this chat’s settings. Review them and try again.'));
        return false;
      }
      if (!canSubmit()) {
        if (alive) notice.set(changed());
        return false;
      }
      const request: AgentGoalChange =
        command.action === 'create'
          ? {
              kind: 'create',
              sessionId,
              objective: trimHostWhitespace(command.objective),
              tokenBudget: command.tokenBudget,
              start: true,
              approval: approval!,
            }
          : {
              kind: 'control',
              sessionId,
              goalId: command.expected.id,
              revision: command.expected.revision,
              action: command.action,
              ...(command.tokenBudget !== undefined
                ? { budget: { tokenBudget: command.tokenBudget } }
                : {}),
              ...(approval ? { approval } : {}),
            };
      submitted = true;
      const result = await goalHost.change(rootId, gen, request);
      if (!alive) return false;
      if (result.kind === 'committed') {
        hapticNotification('success');
        if (generation() === gen && (current()?.revision ?? 0) < result.revision)
          operation.set({ generation: gen, through: result.revision });
        if (generation() === gen) await refresh(gen);
        return true;
      }
      notice.set(result.kind === 'conflict' ? changed() : goalRejection(result.reason));
      hapticNotification('warning');
      if (generation() === gen) await refresh(gen);
      return false;
    } catch (cause) {
      if (!alive) return false;
      console.warn('Could not change goal', cause);
      if (!submitted || cause instanceof MutationNotSubmitted) {
        notice.set(cause instanceof Error ? cause.message : tr('Could not update the goal.'));
      } else {
        notice.set(tr('Could not confirm the goal change. Check its status before trying again.'));
        if (generation() === gen) await refresh(gen);
      }
      hapticNotification('warning');
      return false;
    } finally {
      if (alive && operation() === flight) operation.set(null);
    }
  }

  return {
    view,
    current,
    synced,
    canReconnect,
    reconnectWatch,
    busy,
    writable,
    hasRecord,
    showEntry,
    notice,
    change,
    clearNotice: () => notice.set(null),
    refresh: () => {
      const gen = generation();
      if (gen === undefined) return;
      if (canReconnect()) reconnectWatch();
      else if (showEntry()) return refresh(gen);
    },
  };
}
