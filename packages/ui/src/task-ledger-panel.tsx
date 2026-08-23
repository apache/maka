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

import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { Banner, Collapsible, EmptyState, IconButton, Spinner } from '@astryxdesign/core';
import type { Task, TaskStatus } from '@maka/core/task-ledger';
import {
  ICON_SIZE,
  AlertCircle,
  Ban,
  CheckCircle2,
  CircleGauge,
  Clock,
  ListTodo,
  RefreshCcw,
  X,
} from './icons.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy, type SharedUiCopy } from './shared-ui-copy.js';

const STATUS_ICONS = {
  pending: Clock,
  in_progress: CircleGauge,
  blocked: AlertCircle,
  completed: CheckCircle2,
  failed: X,
  cancelled: Ban,
} satisfies Record<TaskStatus, typeof Clock>;

export interface TaskLedgerPanelProps {
  tasks: readonly Task[];
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
}

export interface TaskLedgerPanelModel {
  activeCount: number;
  activeTree: Task[];
  recentTerminalCount: number;
  recentTerminalTree: Task[];
}

export function deriveTaskLedgerPanelModel(tasks: readonly Task[]): TaskLedgerPanelModel {
  const activeSeeds = tasks.filter((task) => !isTerminal(task.status));
  const recentTerminalSeeds = tasks
    .filter((task) => isTerminal(task.status))
    .sort((a, b) => (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt))
    .slice(0, 3);
  return {
    activeCount: activeSeeds.length,
    activeTree: orderTaskTree(withAncestors(tasks, activeSeeds)),
    recentTerminalCount: recentTerminalSeeds.length,
    recentTerminalTree: orderTaskTree(withAncestors(tasks, recentTerminalSeeds)),
  };
}

export function TaskLedgerPanel(props: TaskLedgerPanelProps) {
  const copy = getSharedUiCopy(useUiLocale()).taskLedger;
  const model = useMemo(() => deriveTaskLedgerPanelModel(props.tasks), [props.tasks]);

  return (
    <section className="maka-task-ledger-panel" aria-label={copy.ariaLabel}>
      {props.error ? (
        <Banner
          status="error"
          role="alert"
          className="maka-task-ledger-message"
          title={props.error}
          endContent={props.onRetry ? (
            <IconButton
              variant="ghost"
              size="sm"
              className="maka-task-ledger-retry"
              onClick={props.onRetry}
              label={copy.retry}
              tooltip={copy.retry}
              icon={<RefreshCcw size={ICON_SIZE.control} aria-hidden="true" />}
            />
          ) : undefined}
        />
      ) : props.loading && props.tasks.length === 0 ? (
        <Spinner size="sm" shade="subtle" label={copy.loading} className="maka-task-ledger-message" />
      ) : (
        <>
          {model.activeCount > 0 ? (
            <div className="maka-task-ledger-tree" role="tree" aria-label={copy.activeAriaLabel}>
              <TaskLedgerTree tasks={model.activeTree} copy={copy} />
            </div>
          ) : (
            <EmptyState
              isCompact
              className="maka-task-ledger-empty"
              icon={<ListTodo size={ICON_SIZE.empty} aria-hidden="true" />}
              title={copy.empty}
            />
          )}
          {model.recentTerminalCount > 0 && (
            <Collapsible
              className="maka-task-ledger-terminal"
              defaultIsOpen={false}
              trigger={(
                <span className="maka-task-ledger-terminal-trigger">
                  <span>{copy.recent}</span>
                  <span>{model.recentTerminalCount}</span>
                </span>
              )}
            >
              <div className="maka-task-ledger-tree" role="tree" aria-label={copy.recentAriaLabel}>
                <TaskLedgerTree tasks={model.recentTerminalTree} copy={copy} />
              </div>
            </Collapsible>
          )}
        </>
      )}
    </section>
  );
}

function TaskLedgerTree({ tasks, copy }: { tasks: readonly Task[]; copy: SharedUiCopy['taskLedger'] }) {
  const included = new Set(tasks.map((task) => task.id));
  const childrenByParent = new Map<string | undefined, Task[]>();
  for (const task of tasks) {
    const parent = task.parentId && included.has(task.parentId) ? task.parentId : undefined;
    const siblings = childrenByParent.get(parent) ?? [];
    siblings.push(task);
    childrenByParent.set(parent, siblings);
  }
  const renderLevel = (parentId: string | undefined, level: number): ReactNode => {
    const siblings = childrenByParent.get(parentId) ?? [];
    return siblings.map((task, index) => (
      <TaskLedgerRow
        key={task.id}
        task={task}
        copy={copy}
        level={level}
        position={index + 1}
        setSize={siblings.length}
      >
        {childrenByParent.has(task.id) ? (
          <div role="group" className="maka-task-ledger-group">
            {renderLevel(task.id, level + 1)}
          </div>
        ) : null}
      </TaskLedgerRow>
    ));
  };
  return renderLevel(undefined, 1);
}

function TaskLedgerRow({ task, copy, level, position, setSize, children }: {
  task: Task;
  copy: SharedUiCopy['taskLedger'];
  level: number;
  position: number;
  setSize: number;
  children?: ReactNode;
}) {
  const StatusIcon = STATUS_ICONS[task.status];
  const depth = level - 1;
  const detail = task.blockedReason ?? task.failureReason ?? task.completionEvidence;
  const owner = task.owner?.actor === 'child_agent'
    ? copy.childAgent(task.owner.agentId)
    : task.owner?.actor === 'main_agent' ? copy.mainAgent : undefined;
  return (
    <div
      className="maka-task-ledger-row"
      role="treeitem"
      aria-level={level}
      aria-posinset={position}
      aria-setsize={setSize}
      data-status={task.status}
      style={{ '--task-depth': Math.min(depth, 6) } as CSSProperties}
    >
      <StatusIcon size={ICON_SIZE.control} aria-hidden="true" />
      <code className="maka-task-ledger-key">{task.key}</code>
      <span className="maka-task-ledger-subject" title={task.subject}>{task.subject}</span>
      <span className="maka-task-ledger-meta">
        <span>{copy.status[task.status]}</span>
        {owner && <span title={owner}>{owner}</span>}
      </span>
      {detail && <span className="maka-task-ledger-detail" title={detail}>{detail}</span>}
      {children}
    </div>
  );
}

function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function orderTaskTree(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => compareKeys(a.key, b.key));
}

function withAncestors(allTasks: readonly Task[], seeds: readonly Task[]): Task[] {
  const byId = new Map(allTasks.map((task) => [task.id, task]));
  const selected = new Map<string, Task>();
  for (const seed of seeds) {
    let current: Task | undefined = seed;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      selected.set(current.id, current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  return [...selected.values()];
}

function compareKeys(left: string, right: string): number {
  const a = left.slice(1).split('.').map(Number);
  const b = right.slice(1).split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}
