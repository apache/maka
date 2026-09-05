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
import type { AgentGraphClientSnapshot } from '@maka/runtime/stream-graph-read-model';
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
  isAgentGraphLive,
  isAgentGraphPanelDismissible,
  reconcileAgentGraphPanelDismissals,
  shouldShowAgentGraphPanel,
  type AgentGraphPanelDismissals,
} from './agent-graph-panel-visibility.js';
import {
  createAgentGraphRefreshScheduler,
  type AgentGraphRefreshScheduler,
} from './agent-graph-refresh.js';
import { getAgentGraphPanelCopy } from './locales/agent-graph-copy.js';

const noopAgentGraphRefreshScheduler: AgentGraphRefreshScheduler = {
  requestRefresh() {},
  invalidateAndRefresh() {},
  isCurrent: () => false,
  dispose() {},
};

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
  const [collapsed, setCollapsed] = useState<boolean>();
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
  // One liveness judgment gates both animated signals.
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
