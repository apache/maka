import { useMemo, type CSSProperties } from 'react';
import { Collapsible } from '@astryxdesign/core';
import type { Task, TaskStatus } from '@maka/core';
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  CircleGauge,
  Clock,
  RefreshCcw,
  X,
} from './icons.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy, type SharedUiCopy } from './shared-ui-copy.js';
import { EmptyState } from './empty-state.js';

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
        <div className="maka-task-ledger-message" role="alert">
          <span>{props.error}</span>
          {props.onRetry && (
            <button type="button" className="maka-task-ledger-retry" onClick={props.onRetry} title={copy.retry}>
              <RefreshCcw size={14} aria-hidden="true" />
              <span className="sr-only">{copy.retry}</span>
            </button>
          )}
        </div>
      ) : props.loading && props.tasks.length === 0 ? (
        <div className="maka-task-ledger-message" role="status">{copy.loading}</div>
      ) : (
        <>
          {model.activeCount > 0 ? (
            <div className="maka-task-ledger-tree" role="tree" aria-label={copy.activeAriaLabel}>
              {model.activeTree.map((task) => <TaskLedgerRow key={task.id} task={task} copy={copy} />)}
            </div>
          ) : (
            <EmptyState variant="inline" title={copy.empty} body="" />
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
                {model.recentTerminalTree.map((task) => <TaskLedgerRow key={task.id} task={task} copy={copy} />)}
              </div>
            </Collapsible>
          )}
        </>
      )}
    </section>
  );
}

function TaskLedgerRow({ task, copy }: { task: Task; copy: SharedUiCopy['taskLedger'] }) {
  const StatusIcon = STATUS_ICONS[task.status];
  const depth = Math.max(0, task.key.split('.').length - 1);
  const detail = task.blockedReason ?? task.failureReason ?? task.completionEvidence;
  const owner = task.owner?.actor === 'child_agent'
    ? copy.childAgent(task.owner.agentId)
    : task.owner?.actor === 'main_agent' ? copy.mainAgent : undefined;
  return (
    <div
      className="maka-task-ledger-row"
      role="treeitem"
      aria-level={depth + 1}
      data-status={task.status}
      style={{ '--task-depth': Math.min(depth, 6) } as CSSProperties}
    >
      <StatusIcon size={14} aria-hidden="true" />
      <span className="maka-task-ledger-key">{task.key}</span>
      <span className="maka-task-ledger-subject" title={task.subject}>{task.subject}</span>
      <span className="maka-task-ledger-meta">
        <span>{copy.status[task.status]}</span>
        {owner && <span title={owner}>{owner}</span>}
      </span>
      {detail && <span className="maka-task-ledger-detail" title={detail}>{detail}</span>}
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
