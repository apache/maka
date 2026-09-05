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

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';
import type {
  AgentGraphClientOperator,
  AgentGraphClientRunRef,
  AgentGraphClientSnapshot,
  AgentGraphOperatorInspection,
} from '@maka/runtime/stream-graph-read-model';
import type { AgentGraphEpochSummary } from '@maka/runtime-host/protocol';
import { IconButton, Selector, type SelectorOptionType } from '@maka/ui';
import { ICON_SIZE, ChevronDown, X } from '@maka/ui/icons';
import { Banner } from '@astryxdesign/core/Banner';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Spinner } from '@astryxdesign/core/Spinner';
import {
  dismissAgentGraphPanel,
  isAgentGraphLive,
  isAgentGraphPanelDismissible,
  reconcileAgentGraphPanelDismissals,
  shouldShowAgentGraphPanel,
  type AgentGraphPanelDismissals,
} from '../model/agent-graph-panel-visibility.js';
import {
  createAgentGraphRefreshScheduler,
  type AgentGraphRefreshScheduler,
} from '../controller/agent-graph-refresh.js';
import type { AgentGraphEpochDirectory } from '../ports.js';
import { useAgentGraphServices } from '../services-context.js';
import {
  AgentGraphTopology,
  AgentGraphStatusDot,
  firstScheduledWorkPreview,
  scheduledWorkPresentation,
} from './agent-graph-topology.js';

const noopAgentGraphRefreshScheduler: AgentGraphRefreshScheduler = {
  requestRefresh() {},
  invalidateAndRefresh() {},
  isCurrent: () => false,
  dispose() {},
};

const GRAPH_DATE_TIME_FORMATTERS: Record<UiLocale, Intl.DateTimeFormat> = {
  en: new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'medium' }),
  'zh-CN': new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' }),
  'zh-TW': new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'medium' }),
};

function hasSameInspectionPresentation(
  current: AgentGraphOperatorInspection | undefined,
  next: AgentGraphOperatorInspection,
): boolean {
  return (
    current?.graphId === next.graphId &&
    current.operator.operatorId === next.operator.operatorId &&
    current.snapshotVersion === next.snapshotVersion
  );
}

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
  topology: string;
  list: string;
  view: string;
  details: string;
  inspectOperator(name: string): string;
  detailsLoading: string;
  detailsFailed: string;
  openSessionFor(name: string): string;
  workOmitted(count: number): string;
  workItems: string;
  dependenciesDetails: string;
  activations: string;
  claims: string;
  recentActivity: string;
  fromOperator(name: string): string;
  toOperator(name: string): string;
  omittedItems(count: number): string;
  records(count: number): string;
  activationRecords(count: number): string;
  edgeSummary(inbound: number, outbound: number): string;
  selectedResults: string;
  epoch: string;
  currentEpoch: string;
  historicalEpoch: string;
  cappedEpochs(count: number): string;
  noOperators: string;
  hiddenTopology(operators: number, edges: number, work: number): string;
  dependencies(upstream: readonly string[], downstream: readonly string[]): string | undefined;
  progress(settled: number, total: number, hasOmitted: boolean): string;
  status(status: AgentGraphClientSnapshot['status']): string;
  operatorStatus(status: AgentGraphClientOperator['status']): string;
  wait(operator: AgentGraphClientOperator): string | undefined;
};

const AGENT_GRAPH_PANEL_COPY = {
  'zh-CN': {
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
    topology: '拓扑',
    list: '列表',
    view: 'Agent Graph 视图',
    details: 'Operator 详情',
    inspectOperator: (name) => `查看 ${name} 详情`,
    detailsLoading: '正在读取 operator 详情…',
    detailsFailed: '无法读取 operator 详情。',
    openSessionFor: (name) => `打开 ${name} 子任务`,
    workOmitted: (count) => `另有 ${count} 项 work 已省略`,
    workItems: 'Work',
    dependenciesDetails: '依赖关系',
    activations: 'Activations',
    claims: 'Claims',
    recentActivity: '近期活动',
    fromOperator: (name) => `来自 ${name}`,
    toOperator: (name) => `前往 ${name}`,
    omittedItems: (count) => `另有 ${count} 项已省略`,
    records: (count) => `${count} 条记录`,
    activationRecords: (count) => `${count} 条 activation 记录`,
    edgeSummary: (inbound, outbound) => `${inbound} 条入边 · ${outbound} 条出边`,
    selectedResults: '已选择结果',
    epoch: 'Graph 运行轮次',
    currentEpoch: '当前',
    historicalEpoch: '历史记录（只读）',
    cappedEpochs: (count) => `仅显示最近 ${count} 次运行`,
    noOperators: '等待主 Agent 创建 operator…',
    hiddenTopology: (operators, edges, work) => {
      const parts = [
        ...(operators > 0 ? [`${operators} 个 operator`] : []),
        ...(edges > 0 ? [`${edges} 条边`] : []),
        ...(work > 0 ? [`${work} 项 work`] : []),
      ];
      return `当前拓扑不完整：省略 ${parts.join('、')}`;
    },
    dependencies: (upstream, downstream) => {
      const parts = [
        ...(upstream.length > 0 ? [`依赖 ${upstream.join('、')}`] : []),
        ...(downstream.length > 0 ? [`下游 ${downstream.join('、')}`] : []),
      ];
      return parts.length > 0 ? parts.join(' · ') : undefined;
    },
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
  },
  'zh-TW': {
    title: 'Agent Graph',
    loading: '正在讀取 Graph 狀態…',
    retry: '重試',
    collapse: '收起 Agent Graph',
    expand: '展開 Agent Graph',
    dismiss: '關閉 Agent Graph',
    stop: '停止 Graph',
    stopping: '停止中…',
    stopFailed: '停止 Graph 失敗，請重試。',
    loadFailed: 'Graph 狀態重新整理失敗。',
    openSession: '開啟子任務',
    operators: 'Operators',
    topology: '拓撲',
    list: '列表',
    view: 'Agent Graph 檢視',
    details: 'Operator 詳情',
    inspectOperator: (name) => `檢視 ${name} 詳情`,
    detailsLoading: '正在讀取 operator 詳情…',
    detailsFailed: '無法讀取 operator 詳情。',
    openSessionFor: (name) => `開啟 ${name} 子任務`,
    workOmitted: (count) => `另有 ${count} 項 work 已省略`,
    workItems: 'Work',
    dependenciesDetails: '相依關係',
    activations: 'Activations',
    claims: 'Claims',
    recentActivity: '近期活動',
    fromOperator: (name) => `來自 ${name}`,
    toOperator: (name) => `前往 ${name}`,
    omittedItems: (count) => `另有 ${count} 項已省略`,
    records: (count) => `${count} 筆記錄`,
    activationRecords: (count) => `${count} 筆 activation 記錄`,
    edgeSummary: (inbound, outbound) => `${inbound} 條入邊 · ${outbound} 條出邊`,
    selectedResults: '已選取結果',
    epoch: 'Graph 執行輪次',
    currentEpoch: '目前',
    historicalEpoch: '歷史記錄（唯讀）',
    cappedEpochs: (count) => `僅顯示最近 ${count} 次執行`,
    noOperators: '等待主 Agent 建立 operator…',
    hiddenTopology: (operators, edges, work) => {
      const parts = [
        ...(operators > 0 ? [`${operators} 個 operator`] : []),
        ...(edges > 0 ? [`${edges} 條邊`] : []),
        ...(work > 0 ? [`${work} 項 work`] : []),
      ];
      return `目前拓撲不完整：省略 ${parts.join('、')}`;
    },
    dependencies: (upstream, downstream) => {
      const parts = [
        ...(upstream.length > 0 ? [`相依 ${upstream.join('、')}`] : []),
        ...(downstream.length > 0 ? [`下游 ${downstream.join('、')}`] : []),
      ];
      return parts.length > 0 ? parts.join(' · ') : undefined;
    },
    progress: (settled, total, hasOmitted) =>
      hasOmitted ? `可見 ${settled}/${total} 已結束` : `${settled}/${total} 已結束`,
    status: (status) =>
      ({
        empty: '等待排程',
        active: '執行中',
        closing: '收尾中',
        waiting: '等待中',
        stopped: '已停止',
        failed: '失敗',
        completed: '已完成',
      })[status],
    operatorStatus: (status) =>
      ({
        not_started: '尚未啟動',
        waiting: '等待',
        runnable: '可執行',
        running: '執行中',
        blocked: '受阻',
        completed: '完成',
        failed: '失敗',
        aborted: '已中止',
        cancelled: '已取消',
      })[status],
    wait: waitReasonZhTw,
  },
  en: {
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
    topology: 'Topology',
    list: 'List',
    view: 'Agent Graph view',
    details: 'Operator details',
    inspectOperator: (name) => `View ${name} details`,
    detailsLoading: 'Loading operator details…',
    detailsFailed: 'Could not load operator details.',
    openSessionFor: (name) => `Open ${name} child task`,
    workOmitted: (count) => `${count} more work item${count === 1 ? '' : 's'} omitted`,
    workItems: 'Work',
    dependenciesDetails: 'Dependencies',
    activations: 'Activations',
    claims: 'Claims',
    recentActivity: 'Recent activity',
    fromOperator: (name) => `From ${name}`,
    toOperator: (name) => `To ${name}`,
    omittedItems: (count) => `${count} more omitted`,
    records: (count) => `${count} record${count === 1 ? '' : 's'}`,
    activationRecords: (count) => `${count} activation record${count === 1 ? '' : 's'}`,
    edgeSummary: (inbound, outbound) => `${inbound} inbound · ${outbound} outbound`,
    selectedResults: 'Selected results',
    epoch: 'Graph run',
    currentEpoch: 'Current',
    historicalEpoch: 'History (read-only)',
    cappedEpochs: (count) => `Showing the newest ${count} runs`,
    noOperators: 'Waiting for the main agent to create an operator…',
    hiddenTopology: (operators, edges, work) => {
      const parts = [
        ...(operators > 0 ? [`${operators} operator${operators === 1 ? '' : 's'}`] : []),
        ...(edges > 0 ? [`${edges} edge${edges === 1 ? '' : 's'}`] : []),
        ...(work > 0 ? [`${work} work item${work === 1 ? '' : 's'}`] : []),
      ];
      return `Partial topology: ${parts.join(', ')} omitted`;
    },
    dependencies: (upstream, downstream) => {
      const parts = [
        ...(upstream.length > 0 ? [`Depends on ${upstream.join(', ')}`] : []),
        ...(downstream.length > 0 ? [`Feeds ${downstream.join(', ')}`] : []),
      ];
      return parts.length > 0 ? parts.join(' · ') : undefined;
    },
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
  },
} satisfies UiCatalog<GraphPanelCopy>;

export function getAgentGraphPanelCopy(locale: UiLocale): GraphPanelCopy {
  return AGENT_GRAPH_PANEL_COPY[locale];
}

export function AgentGraphPanel(props: {
  rootSessionId: string;
  enabled: boolean;
  locale: UiLocale;
  onOpenSession(sessionId: string): void;
}): JSX.Element | null {
  const { graphs } = useAgentGraphServices();
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
  const [collapsed, setCollapsed] = useState<boolean>();
  const [view, setView] = useState<'topology' | 'list'>('topology');
  const [selectedOperatorId, setSelectedOperatorId] = useState<string>();
  const [inspection, setInspection] = useState<AgentGraphOperatorInspection>();
  const [inspectionState, setInspectionState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [dismissedBySession, setDismissedBySession] = useState<AgentGraphPanelDismissals>({});
  const contentId = useId();
  const detailsId = useId();
  const refreshRef = useRef<AgentGraphRefreshScheduler>(noopAgentGraphRefreshScheduler);
  const selectedGraphIdRef = useRef<string | undefined>(undefined);
  const followCurrentRef = useRef(true);
  const stopRequestIdRef = useRef(0);
  const inspectionIdentityRef = useRef<string | undefined>(undefined);
  const previousDetailsPresentationRef = useRef<
    { identity: string; view: 'topology' | 'list' } | undefined
  >(undefined);
  const detailsHeadingRef = useRef<HTMLDivElement>(null);
  const copy = getAgentGraphPanelCopy(props.locale);
  const stopFeedbackMatchesSelection =
    stopState.rootSessionId === props.rootSessionId && stopState.graphId === selectedGraphId;
  const stopPending = stopFeedbackMatchesSelection && stopState.pending;
  const stopError = stopFeedbackMatchesSelection && stopState.error;
  const graphLive = !error && snapshot !== undefined && isAgentGraphLive(snapshot.status);

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
    setCollapsed(undefined);
    setView('topology');
    setSelectedOperatorId(undefined);
    setInspection(undefined);
    setInspectionState('idle');
    setLoading(props.enabled);
    let cachedDirectory: AgentGraphEpochDirectory | undefined;

    const scheduler = createAgentGraphRefreshScheduler(async (fence) => {
      if (!cachedDirectory) setLoading(true);
      try {
        let directory: AgentGraphEpochDirectory;
        if (!cachedDirectory) {
          directory = await graphs.listEpochs(props.rootSessionId);
        } else {
          const currentPage = await graphs.listCurrentEpochs(props.rootSessionId);
          directory = sameEpochPage(cachedDirectory, currentPage)
            ? cachedDirectory
            : await graphs.listEpochs(props.rootSessionId);
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
        const next = await graphs.getSnapshot(props.rootSessionId, { graphId });
        if (scheduler.isCurrent(fence) && next.graphId === selectedGraphIdRef.current) {
          setEpochs(nextEpochs);
          setEpochsTruncated(directory.truncated);
          setSelectedGraphId(graphId);
          setCollapsed((current) => current ?? next.status === 'completed');
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
    const unsubscribe = graphs.subscribe(props.rootSessionId, () =>
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
  }, [graphs, props.rootSessionId, props.enabled]);

  useEffect(() => {
    if (!snapshot || !selectedOperatorId) {
      inspectionIdentityRef.current = undefined;
      setInspection(undefined);
      setInspectionState('idle');
      return;
    }
    const identity = `${props.rootSessionId}:${snapshot.graphId}:${selectedOperatorId}`;
    if (inspectionIdentityRef.current !== identity) {
      inspectionIdentityRef.current = identity;
      setInspection(undefined);
    }
    setInspectionState('loading');
    let active = true;
    void graphs
      .inspectOperator(props.rootSessionId, selectedOperatorId, snapshot.graphId)
      .then((next) => {
        if (!active) return;
        setInspection((current) => (hasSameInspectionPresentation(current, next) ? current : next));
        setInspectionState('idle');
      })
      .catch(() => {
        if (!active) return;
        setInspectionState('error');
      });
    return () => {
      active = false;
    };
  }, [graphs, props.rootSessionId, selectedOperatorId, snapshot?.graphId, snapshot?.snapshotVersion]);

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
  const selectedOperator = selectedOperatorId
    ? snapshot?.operators.find((operator) => operator.operatorId === selectedOperatorId)
    : undefined;
  const selectedDetailsIdentity =
    snapshot && selectedOperator
      ? `${snapshot.graphId}:${selectedOperator.operatorId}`
      : undefined;
  const selectedInspection =
    snapshot &&
    selectedOperator &&
    inspection?.operator.operatorId === selectedOperator.operatorId &&
    inspection.graphId === snapshot.graphId
      ? inspection
      : undefined;
  useLayoutEffect(() => {
    const previous = previousDetailsPresentationRef.current;
    if (
      view === 'list' &&
      selectedDetailsIdentity &&
      (previous?.identity !== selectedDetailsIdentity ||
        previous.view !== 'list')
    ) {
      detailsHeadingRef.current?.scrollIntoView?.({ behavior: 'auto', block: 'nearest' });
    }
    previousDetailsPresentationRef.current = selectedDetailsIdentity
      ? { identity: selectedDetailsIdentity, view }
      : undefined;
  }, [selectedDetailsIdentity, view]);
  const toggleOperator = (operatorId: string) =>
    setSelectedOperatorId((current) => (current === operatorId ? undefined : operatorId));
  const selectedDetails =
    snapshot && selectedOperator && selectedDetailsIdentity ? (
      <AgentGraphOperatorDetails
        id={detailsId}
        operator={selectedOperator}
        snapshot={snapshot}
        inspection={selectedInspection}
        state={inspectionState}
        copy={copy}
        locale={props.locale}
        headingRef={detailsHeadingRef}
        onOpenSession={props.onOpenSession}
      />
    ) : null;

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
      await graphs.stop(rootSessionId, expectedGraphId);
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
    isAgentGraphLive(snapshot.status);
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
      data-live={graphLive ? 'true' : 'false'}
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
              {graphLive ? (
                <Spinner
                  size="sm"
                  shade="subtle"
                  className="maka-agent-graph-heartbeat"
                  aria-hidden="true"
                />
              ) : null}
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
                <>
                  <div className="maka-agent-graph-view-switch">
                    <SegmentedControl
                      size="sm"
                      label={copy.view}
                      value={view}
                      onChange={(value) => setView(value as 'topology' | 'list')}
                    >
                      <SegmentedControlItem value="topology" label={copy.topology} />
                      <SegmentedControlItem value="list" label={copy.list} />
                    </SegmentedControl>
                  </div>
                  {view === 'topology' ? (
                    <>
                      <AgentGraphTopology
                        snapshot={snapshot}
                        selectedOperatorId={selectedOperatorId}
                        statusLabel={copy.operatorStatus}
                        waitLabel={copy.wait}
                        hiddenWorkLabel={copy.workOmitted}
                        onSelect={toggleOperator}
                      />
                      {selectedDetails}
                    </>
                  ) : (
                <ul className="maka-agent-graph-operators" data-testid="agent-graph-list">
                  {snapshot.operators.map((operator) => {
                    const wait = copy.wait(operator);
                    const work = scheduledWorkPresentation(operator, snapshot.work);
                    const visibleWork = work.preview
                      ? [work.preview, work.omitted > 0 ? copy.workOmitted(work.omitted) : undefined]
                          .filter(Boolean)
                          .join(' · ')
                      : work.omitted > 0
                        ? copy.workOmitted(work.omitted)
                        : undefined;
                    const relations = copy.dependencies(
                      snapshot.edges
                        .filter((edge) => edge.toOperatorId === operator.operatorId)
                        .map((edge) => agentName(snapshot, edge.fromOperatorId)),
                      snapshot.edges
                        .filter((edge) => edge.fromOperatorId === operator.operatorId)
                        .map((edge) => agentName(snapshot, edge.toOperatorId)),
                    );
                    return (
                      <li key={operator.operatorId} data-selected={selectedOperatorId === operator.operatorId ? 'true' : 'false'}>
                        <AgentGraphStatusDot
                          status={operator.status}
                          label={copy.operatorStatus(operator.status)}
                        />
                        <span className="maka-agent-graph-operator-copy">
                          <span className="maka-agent-graph-operator-heading">
                            <strong>{operator.agentId}</strong>
                            <span className="maka-agent-graph-operator-status">
                              {copy.operatorStatus(operator.status)}
                            </span>
                          </span>
                          {visibleWork ? <span>{visibleWork}</span> : null}
                          {relations ? (
                            <span className="maka-agent-graph-operator-relations">{relations}</span>
                          ) : null}
                          {wait ? <span className="maka-agent-graph-wait">{wait}</span> : null}
                        </span>
                        <Button
                          variant="secondary"
                          size="sm"
                          label={copy.openSessionFor(operator.agentId)}
                          onClick={() => props.onOpenSession(operator.childSessionId)}
                        >
                          {copy.openSession}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          label={copy.inspectOperator(operator.agentId)}
                          aria-expanded={selectedOperatorId === operator.operatorId}
                          aria-controls={
                            selectedOperatorId === operator.operatorId ? detailsId : undefined
                          }
                          onClick={() => toggleOperator(operator.operatorId)}
                        >
                          {copy.details}
                        </Button>
                        {selectedOperatorId === operator.operatorId ? selectedDetails : null}
                      </li>
                    );
                  })}
                </ul>
                  )}
                </>
              )}
              {snapshot.omitted.operators > 0 || snapshot.omitted.edges > 0 || snapshot.omitted.work > 0 ? (
                <div className="maka-agent-graph-omitted">
                  {copy.hiddenTopology(snapshot.omitted.operators, snapshot.omitted.edges, snapshot.omitted.work)}
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

function AgentGraphOperatorDetails(props: {
  id: string;
  operator: AgentGraphClientOperator;
  snapshot: AgentGraphClientSnapshot;
  inspection: AgentGraphOperatorInspection | undefined;
  state: 'idle' | 'loading' | 'error';
  copy: GraphPanelCopy;
  locale: UiLocale;
  headingRef: RefObject<HTMLDivElement | null>;
  onOpenSession(sessionId: string): void;
}) {
  const operator = props.operator;
  const wait = props.copy.wait(operator);
  const inspection = props.inspection;
  const snapshotWork = firstScheduledWorkPreview(operator, props.snapshot.work);
  return (
    <section
      id={props.id}
      className="maka-agent-graph-details"
      aria-label={`${props.copy.details}: ${operator.agentId}`}
      aria-busy={props.state === 'loading'}
    >
      <div ref={props.headingRef} className="maka-agent-graph-details-heading">
        <strong>{operator.agentId}</strong>
        <span>{props.copy.operatorStatus(operator.status)}</span>
      </div>
      {!inspection && snapshotWork ? <p>{snapshotWork}</p> : null}
      {wait ? <p className="maka-agent-graph-wait">{wait}</p> : null}
      {props.state === 'loading' && !props.inspection ? <span>{props.copy.detailsLoading}</span> : null}
      {props.state === 'error' ? <span role="alert">{props.copy.detailsFailed}</span> : null}
      {inspection ? (
        <>
          <span>
            {props.copy.edgeSummary(
              inspection.inboundEdges.length + inspection.omitted.inboundEdges,
              inspection.outboundEdges.length + inspection.omitted.outboundEdges,
            )} ·{' '}
            {props.copy.activationRecords(
              inspection.activations.length + inspection.omitted.activations,
            )}
          </span>
          <AgentGraphDetailCollection
            label={props.copy.workItems}
            items={inspection.work.map((entry) => ({
              key: entry.workId,
              text: `${humanizeGraphValue(entry.status)} · ${entry.instructionPreview}`,
            }))}
            omitted={inspection.omitted.work}
            omittedItems={props.copy.omittedItems}
          />
          <AgentGraphDetailCollection
            label={props.copy.dependenciesDetails}
            items={[
              ...inspection.inboundEdges.map((edge) => ({
                key: edge.edgeId,
                text: props.copy.fromOperator(agentName(props.snapshot, edge.fromOperatorId)),
              })),
              ...inspection.outboundEdges.map((edge) => ({
                key: edge.edgeId,
                text: props.copy.toOperator(agentName(props.snapshot, edge.toOperatorId)),
              })),
            ]}
            omitted={inspection.omitted.inboundEdges + inspection.omitted.outboundEdges}
            omittedItems={props.copy.omittedItems}
          />
          <AgentGraphDetailCollection
            label={props.copy.activations}
            items={inspection.activations.map((activation) => ({
              key: activation.activationId,
              text: `${humanizeGraphValue(activation.status)} · ${props.copy.records(activation.recordCount)} · ${activation.activationId}`,
              metadata: [
                graphTimeMetadata('firstEventTime', activation.firstEventTime, props.locale),
                graphTimeMetadata('lastEventTime', activation.lastEventTime, props.locale),
                { label: 'lastRecordId', value: activation.lastRecordId },
                ...(activation.terminalRecordId
                  ? [{ label: 'terminalRecordId', value: activation.terminalRecordId }]
                  : []),
                ...graphRunMetadata(activation.run),
              ],
            }))}
            omitted={inspection.omitted.activations}
            omittedItems={props.copy.omittedItems}
          />
          <AgentGraphDetailCollection
            label={props.copy.claims}
            items={inspection.claims.map((claim) => ({
              key: claim.claimId,
              text: `${humanizeGraphValue(claim.admissionState)} · ${claim.claimId}`,
              metadata: [
                { label: 'intentId', value: claim.intentId },
                { label: 'childSessionId', value: claim.childSessionId },
                graphTimeMetadata('claimedAt', claim.claimedAt, props.locale),
                ...graphRunMetadata(claim.run),
              ],
            }))}
            omitted={inspection.omitted.claims}
            omittedItems={props.copy.omittedItems}
          />
          <AgentGraphDetailCollection
            label={props.copy.recentActivity}
            items={inspection.recentRecords.map((record) => ({
              key: record.recordId,
              text: `${record.facets.map(humanizeGraphValue).join(', ') || humanizeGraphValue('runtime_activity')} · ${record.recordId}`,
              metadata: [
                { label: 'activationId', value: record.activationId },
                graphTimeMetadata('eventTime', record.eventTime, props.locale),
                {
                  label: 'signals',
                  value:
                    record.signals.map(graphSignalLabel).join(', ') || humanizeGraphValue('none'),
                },
                ...graphRunMetadata(record.run),
              ],
            }))}
            omitted={inspection.omitted.records}
            omittedItems={props.copy.omittedItems}
          />
        </>
      ) : null}
      <Button
        variant="secondary"
        size="sm"
        label={props.copy.openSessionFor(operator.agentId)}
        onClick={() => props.onOpenSession(operator.childSessionId)}
      >
        {props.copy.openSession}
      </Button>
    </section>
  );
}

function AgentGraphDetailCollection(props: {
  label: string;
  items: readonly {
    key: string;
    text: string;
    metadata?: readonly { label: string; value: ReactNode }[];
  }[];
  omitted: number;
  omittedItems(count: number): string;
}) {
  if (props.items.length === 0 && props.omitted === 0) return null;
  return (
    <div className="maka-agent-graph-details-collection">
      <strong>{props.label}</strong>
      <ul>
        {props.items.map((item) => (
          <li key={item.key}>
            <span>{item.text}</span>
            {item.metadata ? (
              <dl className="maka-agent-graph-details-metadata">
                {item.metadata.map((entry) => (
                  <div key={entry.label}>
                    <dt>{entry.label}</dt>
                    <dd>{entry.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </li>
        ))}
        {props.omitted > 0 ? <li>{props.omittedItems(props.omitted)}</li> : null}
      </ul>
    </div>
  );
}

function humanizeGraphValue(value: string): string {
  return value.replaceAll('_', ' ');
}

function graphRunMetadata(
  run: AgentGraphClientRunRef,
): readonly { label: string; value: string }[] {
  return [
    { label: 'run.sessionId', value: run.sessionId },
    { label: 'run.agentRunId', value: run.agentRunId },
    ...(run.turnId ? [{ label: 'run.turnId', value: run.turnId }] : []),
  ];
}

function graphTimeMetadata(
  label: string,
  timestamp: number,
  locale: UiLocale,
): { label: string; value: ReactNode } {
  const date = new Date(timestamp);
  return {
    label,
    value: (
      <time dateTime={date.toISOString()}>
        {GRAPH_DATE_TIME_FORMATTERS[locale].format(date)}
      </time>
    ),
  };
}

function graphSignalLabel(
  signal: AgentGraphOperatorInspection['recentRecords'][number]['signals'][number],
): string {
  return signal.kind === 'attention'
    ? `${signal.kind}: ${humanizeGraphValue(signal.reason)}`
    : `${signal.kind}: ${humanizeGraphValue(signal.status)}`;
}

function agentName(snapshot: AgentGraphClientSnapshot, operatorId: string): string {
  return (
    snapshot.operators.find((operator) => operator.operatorId === operatorId)?.agentId ?? operatorId
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

function waitReasonEn(operator: AgentGraphClientOperator): string | undefined {
  const waits = operator.readiness
    .filter((readiness) => readiness.status === 'waiting')
    .flatMap((readiness) => readiness.waitingFor);
  const wait = waits[0];
  const reason = wait
    ? wait.kind === 'input_route'
      ? `Waiting for input from ${wait.upstreamOperatorIds.join(', ')}`
      : wait.kind === 'activation_missing'
        ? `Waiting for ${wait.operatorId} activation`
        : `Waiting for ${wait.operatorId} to settle`
    : undefined;
  const moreWaits = Math.max(0, waits.length - 1);
  const parts = [
    reason,
    ...(moreWaits > 0 ? [`${moreWaits} more wait${moreWaits === 1 ? '' : 's'}`] : []),
    ...(operator.omitted.readinessWaits > 0
      ? [`${operator.omitted.readinessWaits} wait${operator.omitted.readinessWaits === 1 ? '' : 's'} omitted`]
      : []),
    ...(operator.omitted.readiness > 0
      ? [`${operator.omitted.readiness} readiness check${operator.omitted.readiness === 1 ? '' : 's'} omitted`]
      : []),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function waitReasonZh(operator: AgentGraphClientOperator): string | undefined {
  const waits = operator.readiness
    .filter((readiness) => readiness.status === 'waiting')
    .flatMap((readiness) => readiness.waitingFor);
  const wait = waits[0];
  const reason = wait
    ? wait.kind === 'input_route'
      ? `等待 ${wait.upstreamOperatorIds.join('、')} 的输入`
      : wait.kind === 'activation_missing'
        ? `等待 ${wait.operatorId} activation`
        : `等待 ${wait.operatorId} 结束`
    : undefined;
  const moreWaits = Math.max(0, waits.length - 1);
  const parts = [
    reason,
    ...(moreWaits > 0 ? [`另有 ${moreWaits} 项等待条件`] : []),
    ...(operator.omitted.readinessWaits > 0
      ? [`${operator.omitted.readinessWaits} 项等待条件已省略`]
      : []),
    ...(operator.omitted.readiness > 0
      ? [`${operator.omitted.readiness} 项 readiness 检查已省略`]
      : []),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function waitReasonZhTw(operator: AgentGraphClientOperator): string | undefined {
  const waits = operator.readiness
    .filter((readiness) => readiness.status === 'waiting')
    .flatMap((readiness) => readiness.waitingFor);
  const wait = waits[0];
  const reason = wait
    ? wait.kind === 'input_route'
      ? `等待 ${wait.upstreamOperatorIds.join('、')} 的輸入`
      : wait.kind === 'activation_missing'
        ? `等待 ${wait.operatorId} activation`
        : `等待 ${wait.operatorId} 結束`
    : undefined;
  const moreWaits = Math.max(0, waits.length - 1);
  const parts = [
    reason,
    ...(moreWaits > 0 ? [`另有 ${moreWaits} 項等待條件`] : []),
    ...(operator.omitted.readinessWaits > 0
      ? [`${operator.omitted.readinessWaits} 項等待條件已省略`]
      : []),
    ...(operator.omitted.readiness > 0
      ? [`${operator.omitted.readiness} 項 readiness 檢查已省略`]
      : []),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
