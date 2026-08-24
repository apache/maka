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

import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react';
import type { UiLocale } from '@maka/core/ui-locale';
import type {
  AgentGraphClientOperator,
  AgentGraphClientSnapshot,
} from '@maka/runtime/stream-graph-read-model';
import type { AgentGraphEpochDirectory } from '@maka/runtime-host/client';
import type { AgentGraphEpochSummary } from '@maka/runtime-host/protocol';
import { IconButton, Selector, type SelectorOptionType } from '@maka/ui';
import { ICON_SIZE, ChevronDown, X } from '@maka/ui/icons';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Spinner } from '@astryxdesign/core/Spinner';
import {
  dismissAgentGraphPanel,
  isAgentGraphPanelDismissible,
  reconcileAgentGraphPanelDismissals,
  shouldShowAgentGraphPanel,
  type AgentGraphPanelDismissals,
} from './agent-graph-panel-visibility.js';
import {
  createAgentGraphRefreshScheduler,
  type AgentGraphRefreshScheduler,
} from './agent-graph-refresh.js';

const noopAgentGraphRefreshScheduler: AgentGraphRefreshScheduler = {
  requestRefresh() {},
  invalidateAndRefresh() {},
  isCurrent: () => false,
  dispose() {},
};

type GraphPanelCopy = {
  title: string;
  loading: string;
  retry: string;
  collapse: string;
  expand: string;
  dismiss: string;
  stop: string;
  stopping: string;
  stopFailed: string;
  loadFailed: string;
  openSession: string;
  operators: string;
  selectedResults: string;
  epoch: string;
  currentEpoch: string;
  historicalEpoch: string;
  cappedEpochs(count: number): string;
  noOperators: string;
  hiddenOperators(count: number): string;
  progress(settled: number, total: number, hasOmitted: boolean): string;
  status(status: AgentGraphClientSnapshot['status']): string;
  operatorStatus(status: AgentGraphClientOperator['status']): string;
  wait(operator: AgentGraphClientOperator): string | undefined;
};

export function getAgentGraphPanelCopy(locale: UiLocale): GraphPanelCopy {
  if (locale === 'zh') {
    return {
      title: 'Agent Graph',
      loading: '正在读取 Graph 状态…',
      retry: '重试',
      collapse: '收起 Agent Graph',
      expand: '展开 Agent Graph',
      dismiss: '关闭 Agent Graph',
      stop: '停止 Graph',
      stopping: '停止中…',
      stopFailed: '停止 Graph 失败，请重试。',
      loadFailed: 'Graph 状态刷新失败。',
      openSession: '打开子任务',
      operators: 'Operators',
      selectedResults: '已选择结果',
      epoch: 'Graph 运行轮次',
      currentEpoch: '当前',
      historicalEpoch: '历史记录（只读）',
      cappedEpochs: (count) => `仅显示最近 ${count} 次运行`,
      noOperators: '等待主 Agent 创建 operator…',
      hiddenOperators: (count) => `另有 ${count} 个 operator`,
      progress: (settled, total, hasOmitted) =>
        hasOmitted ? `可见 ${settled}/${total} 已结束` : `${settled}/${total} 已结束`,
      status: (status) =>
        ({
          empty: '等待调度',
          active: '运行中',
          closing: '收尾中',
          waiting: '等待中',
          stopped: '已停止',
          failed: '失败',
          completed: '已完成',
        })[status],
      operatorStatus: (status) =>
        ({
          not_started: '未启动',
          waiting: '等待',
          runnable: '可运行',
          running: '运行中',
          blocked: '受阻',
          completed: '完成',
          failed: '失败',
          aborted: '中止',
          cancelled: '取消',
        })[status],
      wait: waitReasonZh,
    };
  }
  return {
    title: 'Agent Graph',
    loading: 'Loading graph state…',
    retry: 'Retry',
    collapse: 'Collapse Agent Graph',
    expand: 'Expand Agent Graph',
    dismiss: 'Dismiss Agent Graph',
    stop: 'Stop graph',
    stopping: 'Stopping…',
    stopFailed: 'Could not stop the graph. Try again.',
    loadFailed: 'Could not refresh graph state.',
    openSession: 'Open child task',
    operators: 'Operators',
    selectedResults: 'Selected results',
    epoch: 'Graph run',
    currentEpoch: 'Current',
    historicalEpoch: 'History (read-only)',
    cappedEpochs: (count) => `Showing the newest ${count} runs`,
    noOperators: 'Waiting for the main agent to create an operator…',
    hiddenOperators: (count) => `${count} more operator${count === 1 ? '' : 's'}`,
    progress: (settled, total, hasOmitted) =>
      hasOmitted ? `${settled}/${total} visible settled` : `${settled}/${total} settled`,
    status: (status) =>
      ({
        empty: 'Awaiting schedule',
        active: 'Running',
        closing: 'Finishing',
        waiting: 'Waiting',
        stopped: 'Stopped',
        failed: 'Failed',
        completed: 'Completed',
      })[status],
    operatorStatus: (status) =>
      ({
        not_started: 'Not started',
        waiting: 'Waiting',
        runnable: 'Runnable',
        running: 'Running',
        blocked: 'Blocked',
        completed: 'Completed',
        failed: 'Failed',
        aborted: 'Aborted',
        cancelled: 'Cancelled',
      })[status],
    wait: waitReasonEn,
  };
}

export function AgentGraphPanel(props: {
  rootSessionId: string;
  enabled: boolean;
  locale: UiLocale;
  onOpenSession(sessionId: string): void;
}): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<AgentGraphClientSnapshot>();
  const [epochs, setEpochs] = useState<readonly AgentGraphEpochSummary[]>([]);
  const [epochsTruncated, setEpochsTruncated] = useState(false);
  const [selectedGraphId, setSelectedGraphId] = useState<string>();
  const [loading, setLoading] = useState(props.enabled);
  const [error, setError] = useState(false);
  const [stopState, setStopState] = useState({
    rootSessionId: props.rootSessionId,
    graphId: undefined as string | undefined,
    requestId: 0,
    pending: false,
    error: false,
  });
  const [collapsed, setCollapsed] = useState(false);
  const [dismissedBySession, setDismissedBySession] = useState<AgentGraphPanelDismissals>({});
  const contentId = useId();
  const refreshRef = useRef<AgentGraphRefreshScheduler>(noopAgentGraphRefreshScheduler);
  const selectedGraphIdRef = useRef<string | undefined>(undefined);
  const followCurrentRef = useRef(true);
  const stopRequestIdRef = useRef(0);
  const copy = getAgentGraphPanelCopy(props.locale);
  const stopFeedbackMatchesSelection =
    stopState.rootSessionId === props.rootSessionId && stopState.graphId === selectedGraphId;
  const stopPending = stopFeedbackMatchesSelection && stopState.pending;
  const stopError = stopFeedbackMatchesSelection && stopState.error;

  useEffect(() => {
    setSnapshot(undefined);
    setEpochs([]);
    setEpochsTruncated(false);
    setSelectedGraphId(undefined);
    selectedGraphIdRef.current = undefined;
    followCurrentRef.current = true;
    setError(false);
    setStopState({
      rootSessionId: props.rootSessionId,
      graphId: undefined,
      requestId: ++stopRequestIdRef.current,
      pending: false,
      error: false,
    });
    setCollapsed(false);
    setLoading(props.enabled);
    let cachedDirectory: AgentGraphEpochDirectory | undefined;

    const scheduler = createAgentGraphRefreshScheduler(async (fence) => {
      if (!cachedDirectory) setLoading(true);
      try {
        let directory: AgentGraphEpochDirectory;
        if (!cachedDirectory) {
          directory = await window.maka.graphs.listEpochs(props.rootSessionId);
        } else {
          const currentPage = await window.maka.graphs.listCurrentEpochs(props.rootSessionId);
          directory = sameEpochPage(cachedDirectory, currentPage)
            ? cachedDirectory
            : await window.maka.graphs.listEpochs(props.rootSessionId);
        }
        if (!scheduler.isCurrent(fence)) return;
        cachedDirectory = directory;
        const nextEpochs = directory.epochs;
        const current = nextEpochs.find((entry) => entry.current) ?? nextEpochs[0];
        const selected = followCurrentRef.current
          ? current
          : nextEpochs.find((entry) => entry.graphId === selectedGraphIdRef.current);
        // An evicted selection must not pin the panel on the fallback:
        // resume following the current epoch so later rollovers refresh.
        if (!selected && !followCurrentRef.current) {
          followCurrentRef.current = true;
        }
        const graphId = (selected ?? current)?.graphId;
        if (!graphId) throw new Error('Agent graph epoch directory is empty');
        selectedGraphIdRef.current = graphId;
        const next = await window.maka.graphs.getSnapshot(props.rootSessionId, { graphId });
        if (scheduler.isCurrent(fence) && next.graphId === selectedGraphIdRef.current) {
          setEpochs(nextEpochs);
          setEpochsTruncated(directory.truncated);
          setSelectedGraphId(graphId);
          setSnapshot(next);
          setError(false);
        }
      } catch {
        if (scheduler.isCurrent(fence)) setError(true);
      } finally {
        if (scheduler.isCurrent(fence)) setLoading(false);
      }
    });

    refreshRef.current = scheduler;
    const unsubscribe = window.maka.graphs.subscribe(props.rootSessionId, () =>
      scheduler.requestRefresh(),
    );
    scheduler.requestRefresh();
    return () => {
      scheduler.dispose();
      if (refreshRef.current === scheduler) {
        refreshRef.current = noopAgentGraphRefreshScheduler;
      }
      unsubscribe();
    };
  }, [props.rootSessionId, props.enabled]);

  useEffect(() => {
    setDismissedBySession((current) =>
      reconcileAgentGraphPanelDismissals(
        current,
        props.rootSessionId,
        snapshot
          ? {
              rootSessionId: snapshot.rootSessionId,
              graphId: snapshot.graphId,
              status: snapshot.status,
            }
          : undefined,
      ),
    );
  }, [props.rootSessionId, snapshot]);

  const progress = useMemo(() => {
    const settled = snapshot?.operators.filter((operator) =>
      ['completed', 'failed', 'aborted', 'cancelled'].includes(operator.status),
    ).length ?? 0;
    return { settled, total: snapshot?.operators.length ?? 0 };
  }, [snapshot]);
  const selectedEpoch = epochs.find((entry) => entry.graphId === selectedGraphId);

  const hasGraphActivity =
    snapshot !== undefined &&
    (snapshot.scheduleRevision > 0 ||
      snapshot.operators.length > 0 ||
      snapshot.omitted.operators > 0);
  const hasGraphHistory = epochs.length > 1;
  if (
    !shouldShowAgentGraphPanel({
      enabled: props.enabled,
      hasGraphActivity: hasGraphActivity || hasGraphHistory,
      error,
      sessionId: props.rootSessionId,
      graphId: snapshot?.graphId,
      status: snapshot?.status,
      dismissedBySession,
    })
  ) {
    return null;
  }

  const stopGraph = async (expectedGraphId: string): Promise<void> => {
    if (stopPending) return;
    const rootSessionId = props.rootSessionId;
    const requestId = ++stopRequestIdRef.current;
    setStopState({ rootSessionId, graphId: expectedGraphId, requestId, pending: true, error: false });
    try {
      await window.maka.graphs.stop(rootSessionId, expectedGraphId);
    } catch {
      setStopState((current) =>
        current.rootSessionId === rootSessionId && current.requestId === requestId
          ? { ...current, error: true }
          : current,
      );
    } finally {
      setStopState((current) =>
        current.rootSessionId === rootSessionId && current.requestId === requestId
          ? { ...current, pending: false }
          : current,
      );
    }
  };
  const stopAvailable =
    selectedEpoch?.current === true &&
    !loading &&
    snapshot !== undefined &&
    snapshot.graphId === selectedGraphId &&
    ['active', 'waiting', 'closing'].includes(snapshot.status);
  const dismissAvailable =
    selectedEpoch?.current === true &&
    !loading &&
    snapshot !== undefined &&
    snapshot.graphId === selectedGraphId &&
    isAgentGraphPanelDismissible(snapshot.status);

  return (
    <section
      className="maka-agent-graph-panel"
      aria-label={copy.title}
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <header className="maka-agent-graph-heading">
        <div className="maka-agent-graph-heading-copy">
          <strong>{copy.title}</strong>
          {epochs.length > 1 && snapshot ? (
            <Selector
              className="maka-agent-graph-epoch-selector"
              size="sm"
              label={copy.epoch}
              isLabelHidden
              value={selectedGraphId ?? snapshot.graphId}
              options={epochs.map((entry) => ({
                value: entry.graphId,
                label: `#${entry.epoch} · ${entry.current ? copy.currentEpoch : copy.historicalEpoch}`,
              }))}
              onChange={(graphId: SelectorOptionType) => {
                if (typeof graphId !== 'string') return;
                selectedGraphIdRef.current = graphId;
                setSelectedGraphId(graphId);
                followCurrentRef.current =
                  epochs.find((entry) => entry.graphId === graphId)?.current === true;
                refreshRef.current.invalidateAndRefresh();
              }}
            />
          ) : null}
          {epochsTruncated ? (
            <span className="maka-agent-graph-epoch-capped">{copy.cappedEpochs(epochs.length)}</span>
          ) : null}
          {snapshot ? (
            <span className="maka-agent-graph-progress">
              {copy.status(snapshot.status)} ·{' '}
              {copy.progress(
                progress.settled,
                progress.total,
                snapshot.omitted.operators > 0,
              )}
            </span>
          ) : null}
        </div>
        <div className="maka-agent-graph-heading-actions">
          {stopAvailable ? (
            <Button
              variant="secondary"
              size="sm"
              label={stopPending ? copy.stopping : copy.stop}
              isDisabled={stopPending}
              onClick={() => {
                if (snapshot) void stopGraph(snapshot.graphId);
              }}
            />
          ) : null}
          {dismissAvailable && snapshot ? (
            <IconButton
              variant="ghost"
              size="sm"
              className="maka-agent-graph-dismiss"
              label={copy.dismiss}
              tooltip={copy.dismiss}
              icon={<X size={ICON_SIZE.chrome} aria-hidden="true" />}
              onClick={() => {
                setDismissedBySession((current) =>
                  dismissAgentGraphPanel(current, props.rootSessionId, snapshot.graphId),
                );
              }}
            />
          ) : null}
          <IconButton
            variant="ghost"
            size="sm"
            className="maka-agent-graph-collapse-toggle"
            label={collapsed ? copy.expand : copy.collapse}
            tooltip={collapsed ? copy.expand : copy.collapse}
            icon={<ChevronDown size={ICON_SIZE.chrome} aria-hidden="true" />}
            aria-expanded={!collapsed}
            aria-controls={contentId}
            onClick={() => setCollapsed((current) => !current)}
          />
        </div>
      </header>
      {!collapsed ? (
        <div className="maka-agent-graph-content" id={contentId}>
          {stopError ? (
            <Banner status="error" role="alert" title={copy.stopFailed} />
          ) : null}

          {loading && !snapshot ? (
            <Spinner size="sm" shade="subtle" label={copy.loading} className="maka-agent-graph-empty" />
          ) : null}
          {error ? (
            <Banner
              status="error"
              role="alert"
              title={copy.loadFailed}
              endContent={(
                <Button
                  variant="secondary"
                  size="sm"
                  label={copy.retry}
                  onClick={() => refreshRef.current.requestRefresh()}
                />
              )}
            />
          ) : null}

          {snapshot ? (
            <>
              <div className="maka-agent-graph-section-label">{copy.operators}</div>
              {snapshot.operators.length === 0 ? (
                <EmptyState
                  isCompact
                  className="maka-agent-graph-empty"
                  title={copy.noOperators}
                />
              ) : (
                <ul className="maka-agent-graph-operators">
                  {snapshot.operators.map((operator) => {
                    const wait = copy.wait(operator);
                    const work = snapshot.work.find((candidate) =>
                      operator.scheduledWorkIds.includes(candidate.workId),
                    );
                    return (
                      <li key={operator.operatorId} data-status={operator.status}>
                        <span className="maka-agent-graph-status-dot" aria-hidden="true" />
                        <span className="maka-agent-graph-operator-copy">
                          <strong>{operator.agentId}</strong>
                          <span>{work?.instructionPreview ?? operator.operatorId}</span>
                          {wait ? <span className="maka-agent-graph-wait">{wait}</span> : null}
                        </span>
                        <span className="maka-agent-graph-operator-status">
                          {copy.operatorStatus(operator.status)}
                        </span>
                        <Button
                          variant="secondary"
                          size="sm"
                          label={copy.openSession}
                          onClick={() => props.onOpenSession(operator.childSessionId)}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
              {snapshot.omitted.operators > 0 ? (
                <div className="maka-agent-graph-omitted">
                  {copy.hiddenOperators(snapshot.omitted.operators)}
                </div>
              ) : null}
              {snapshot.finish ? (
                <div className="maka-agent-graph-results">
                  <span>{copy.selectedResults}</span>
                  <code>{snapshot.finish.resultIds.join(', ')}</code>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function sameEpochPage(
  cached: AgentGraphEpochDirectory,
  currentPage: AgentGraphEpochDirectory,
): boolean {
  if (!currentPage.truncated && currentPage.epochs.length !== cached.epochs.length) return false;
  return currentPage.epochs.every((entry, index) => {
    const previous = cached.epochs[index];
    return (
      previous?.epoch === entry.epoch &&
      previous.graphId === entry.graphId &&
      previous.current === entry.current
    );
  });
}

function firstWait(operator: AgentGraphClientOperator) {
  return operator.readiness.find((readiness) => readiness.status === 'waiting')?.waitingFor[0];
}

function waitReasonEn(operator: AgentGraphClientOperator): string | undefined {
  const wait = firstWait(operator);
  if (!wait) return undefined;
  if (wait.kind === 'input_route') {
    return `Waiting for input from ${wait.upstreamOperatorIds.join(', ')}`;
  }
  if (wait.kind === 'activation_missing') {
    return `Waiting for ${wait.operatorId} activation`;
  }
  return `Waiting for ${wait.operatorId} to settle`;
}

function waitReasonZh(operator: AgentGraphClientOperator): string | undefined {
  const wait = firstWait(operator);
  if (!wait) return undefined;
  if (wait.kind === 'input_route') {
    return `等待 ${wait.upstreamOperatorIds.join('、')} 的输入`;
  }
  if (wait.kind === 'activation_missing') {
    return `等待 ${wait.operatorId} activation`;
  }
  return `等待 ${wait.operatorId} 结束`;
}
