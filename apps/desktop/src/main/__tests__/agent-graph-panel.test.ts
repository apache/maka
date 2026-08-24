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

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentGraphClientSnapshot } from '@maka/runtime/stream-graph-read-model';
import type { AgentGraphEpochSummary } from '@maka/runtime-host/protocol';
import { AgentGraphPanel } from '../../renderer/agent-graph-panel.js';

type GraphListener = () => void;

interface DeferredRead {
  started: Promise<void>;
  release(): void;
}

interface DeferredReadGate extends DeferredRead {
  markStarted(): void;
  waitForRelease: Promise<void>;
}

function deferredReadGate(): DeferredReadGate {
  let markStarted = () => {};
  let release = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const waitForRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { started, markStarted, release, waitForRelease };
}

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  matchMedia: globalThis.matchMedia,
  HTMLElement: globalThis.HTMLElement,
  HTMLIFrameElement: globalThis.HTMLIFrameElement,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

afterEach(() => {
  Object.assign(globalThis, originalGlobals);
});

function snapshot(
  overrides: Pick<AgentGraphClientSnapshot, 'graphId' | 'status'> &
    Partial<AgentGraphClientSnapshot>,
): AgentGraphClientSnapshot {
  return {
    schemaVersion: 1,
    rootSessionId: 'session-1',
    orchestrationMode: 'graph',
    snapshotVersion: '1',
    scheduleRevision: 1,
    topologyFingerprint: 'fp',
    closed: overrides.status === 'completed',
    operators: [],
    edges: [],
    work: [],
    reconciliationFailures: [],
    stoppedTargets: [],
    claims: [],
    recentControlDecisions: [],
    recentActivity: [],
    terminalHistory: { records: [] },
    omitted: {
      operators: 0,
      edges: 0,
      work: 0,
      reconciliationFailures: 0,
      stoppedTargets: 0,
      claims: 0,
      controlDecisions: 0,
      recentActivity: 0,
    },
    ...overrides,
  };
}

function installGraphRenderer(
  initial: AgentGraphClientSnapshot,
  historical: readonly AgentGraphClientSnapshot[] = [],
): {
  container: Element;
  root: Root;
  setSnapshot(next: AgentGraphClientSnapshot): Promise<void>;
  evict(graphId: string): void;
  renderSession(sessionId: string): Promise<void>;
  holdNextEpochList(sessionId: string): DeferredRead;
  holdNextSnapshot(graphId: string): DeferredRead;
  holdNextStop(sessionId: string): DeferredRead;
  setCurrentWithoutNotification(next: AgentGraphClientSnapshot): void;
  notify(): void;
  epochReadCounts(): { full: number; current: number };
  stopCalls: Array<{ sessionId: string; expectedGraphId: string }>;
} {
  const { document, window } = parseHTML('<div id="root"></div>');
  const matchMedia = (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  Object.assign(window, { matchMedia });
  Object.assign(globalThis, {
    document,
    window,
    matchMedia,
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const snapshots = new Map(
    [initial, ...historical].map((entry) => [entry.graphId, entry] as const),
  );
  const currentGraphIds = new Map<string, string>();
  for (const entry of [initial, ...historical]) {
    if (!currentGraphIds.has(entry.rootSessionId)) {
      currentGraphIds.set(entry.rootSessionId, entry.graphId);
    }
  }
  const listeners = new Set<GraphListener>();
  const epochListGates = new Map<string, DeferredReadGate>();
  const snapshotGates = new Map<string, DeferredReadGate>();
  const stopGates = new Map<string, DeferredReadGate>();
  const stopCalls: Array<{ sessionId: string; expectedGraphId: string }> = [];
  let fullEpochReads = 0;
  let currentEpochReads = 0;
  const epochDirectory = (sessionId: string) => {
    const currentGraphId = currentGraphIds.get(sessionId);
    const entries = [...snapshots.values()]
      .filter((entry) => entry.rootSessionId === sessionId)
      .sort(
        (left, right) =>
          Number(right.graphId === currentGraphId) - Number(left.graphId === currentGraphId),
      );
    return {
      epochs: entries.map((entry, index) => ({
        epoch: entries.length - index,
        graphId: entry.graphId,
        createdAt: entries.length - index,
        current: currentGraphIds.get(sessionId) === entry.graphId,
      })),
      truncated: false,
    };
  };
  (window as unknown as { maka: unknown }).maka = {
    graphs: {
      listEpochs: async (sessionId: string) => {
        fullEpochReads += 1;
        const gate = epochListGates.get(sessionId);
        if (gate) {
          epochListGates.delete(sessionId);
          gate.markStarted();
          await gate.waitForRelease;
        }
        return epochDirectory(sessionId);
      },
      listCurrentEpochs: async (sessionId: string) => {
        currentEpochReads += 1;
        return epochDirectory(sessionId);
      },
      getSnapshot: async (sessionId: string, options?: { graphId?: string }) => {
        const graphId = options?.graphId ?? currentGraphIds.get(sessionId);
        const gate = graphId ? snapshotGates.get(graphId) : undefined;
        if (gate && graphId) {
          snapshotGates.delete(graphId);
          gate.markStarted();
          await gate.waitForRelease;
        }
        const next = graphId ? snapshots.get(graphId) : undefined;
        if (!next || next.rootSessionId !== sessionId) {
          throw new Error(`missing graph snapshot for ${sessionId}`);
        }
        return next;
      },
      inspectOperator: async () => {
        throw new Error('inspectOperator is unused by AgentGraphPanel');
      },
      subscribe: (_sessionId: string, listener: GraphListener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      stop: async (sessionId: string, expectedGraphId: string) => {
        stopCalls.push({ sessionId, expectedGraphId });
        const gate = stopGates.get(sessionId);
        if (gate) {
          stopGates.delete(sessionId);
          gate.markStarted();
          await gate.waitForRelease;
          throw new Error('deferred stop failure');
        }
        if (currentGraphIds.get(sessionId) !== expectedGraphId) {
          throw new Error('graph changed before stop');
        }
      },
    },
  };

  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  return {
    container,
    root,
    async setSnapshot(next) {
      snapshots.set(next.graphId, next);
      currentGraphIds.set(next.rootSessionId, next.graphId);
      await act(async () => {
        for (const listener of [...listeners]) listener();
        await Promise.resolve();
      });
    },
    evict(graphId) {
      snapshots.delete(graphId);
    },
    setCurrentWithoutNotification(next) {
      snapshots.set(next.graphId, next);
      currentGraphIds.set(next.rootSessionId, next.graphId);
    },
    notify() {
      for (const listener of [...listeners]) listener();
    },
    epochReadCounts() {
      return { full: fullEpochReads, current: currentEpochReads };
    },
    async renderSession(sessionId) {
      await act(async () => {
        root.render(
          createElement(AgentGraphPanel, {
            rootSessionId: sessionId,
            enabled: true,
            locale: 'en',
            onOpenSession: () => undefined,
          }),
        );
        await Promise.resolve();
      });
    },
    holdNextEpochList(sessionId) {
      const gate = deferredReadGate();
      epochListGates.set(sessionId, gate);
      return gate;
    },
    holdNextSnapshot(graphId) {
      const gate = deferredReadGate();
      snapshotGates.set(graphId, gate);
      return gate;
    },
    holdNextStop(sessionId) {
      const gate = deferredReadGate();
      stopGates.set(sessionId, gate);
      return gate;
    },
    stopCalls,
  };
}

async function renderPanel(
  initial: AgentGraphClientSnapshot,
): Promise<ReturnType<typeof installGraphRenderer>> {
  const harness = installGraphRenderer(initial);
  await act(async () => {
    harness.root.render(
      createElement(AgentGraphPanel, {
        rootSessionId: 'session-1',
        enabled: true,
        locale: 'en',
        onOpenSession: () => undefined,
      }),
    );
    await Promise.resolve();
  });
  return harness;
}

describe('AgentGraphPanel dismiss', () => {
  it('keeps the new session loading when a disposed read settles later', async () => {
    const sessionA = snapshot({ graphId: 'graph-a', status: 'active' });
    const sessionB = snapshot({
      graphId: 'graph-b',
      status: 'active',
      rootSessionId: 'session-2',
    });
    const harness = installGraphRenderer(sessionA, [sessionB]);
    const readA = harness.holdNextEpochList('session-1');
    await harness.renderSession('session-1');
    await readA.started;

    const readB = harness.holdNextEpochList('session-2');
    await harness.renderSession('session-2');
    await readB.started;
    assert.match(harness.container.textContent ?? '', /Loading graph state/);

    await act(async () => {
      readA.release();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent ?? '', /Loading graph state/);

    await act(async () => {
      readB.release();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent ?? '', /Agent Graph/);
    await act(async () => harness.root.unmount());
  });

  it('does not let a disposed session read overwrite the live session selection refs', async () => {
    const sessionA = snapshot({ graphId: 'graph-a', status: 'active' });
    const sessionBCurrent = snapshot({
      graphId: 'graph-b2',
      status: 'active',
      rootSessionId: 'session-2',
    });
    const sessionBHistory = snapshot({
      graphId: 'graph-b1',
      status: 'completed',
      rootSessionId: 'session-2',
    });
    const harness = installGraphRenderer(sessionA, [sessionBCurrent, sessionBHistory]);
    const readA = harness.holdNextEpochList('session-1');
    await harness.renderSession('session-1');
    await readA.started;

    await harness.renderSession('session-2');
    const selector = harness.container.querySelector('[role="combobox"]');
    assert.ok(selector);
    await act(async () => {
      (selector as HTMLElement).click();
      await Promise.resolve();
    });
    const historyOption = [...document.querySelectorAll('[role="option"]')].find((option) =>
      option.textContent?.includes('History'),
    );
    assert.ok(historyOption);
    await act(async () => {
      (historyOption as HTMLElement).click();
      await Promise.resolve();
    });

    await act(async () => {
      readA.release();
      await Promise.resolve();
    });
    await harness.setSnapshot({ ...sessionBCurrent, status: 'waiting' });
    assert.match(
      harness.container.querySelector('[role="combobox"]')?.textContent ?? '',
      /#1 · History \(read-only\)/,
    );
    await act(async () => harness.root.unmount());
  });

  it('switches to a historical epoch without exposing current-graph controls', async () => {
    const current = snapshot({ graphId: 'graph-2', status: 'active' });
    const previous = snapshot({ graphId: 'graph-1', status: 'completed' });
    const harness = installGraphRenderer(current, [previous]);
    await act(async () => {
      harness.root.render(
        createElement(AgentGraphPanel, {
          rootSessionId: 'session-1',
          enabled: true,
          locale: 'en',
          onOpenSession: () => undefined,
        }),
      );
      await Promise.resolve();
    });

    const selector = harness.container.querySelector('[role="combobox"]');
    assert.ok(selector);
    assert.match(harness.container.textContent ?? '', /Stop graph/);
    await act(async () => {
      (selector as HTMLElement).click();
      await Promise.resolve();
    });
    const historyOption = [...document.querySelectorAll('[role="option"]')].find((option) =>
      option.textContent?.includes('History'),
    );
    assert.ok(historyOption);
    const historyRead = harness.holdNextSnapshot('graph-1');
    await act(async () => {
      (historyOption as HTMLElement).click();
      await historyRead.started;
    });

    assert.match(harness.container.textContent ?? '', /#1 · History \(read-only\)/);
    assert.doesNotMatch(harness.container.textContent ?? '', /Stop graph/);
    assert.equal(harness.container.querySelector('.maka-agent-graph-dismiss'), null);
    assert.deepEqual(harness.stopCalls, []);
    await act(async () => {
      historyRead.release();
      await Promise.resolve();
    });
    await act(async () => harness.root.unmount());
  });

  it('binds stop to the graph identity rendered before a silent rollover', async () => {
    const current = snapshot({ graphId: 'graph-1', status: 'active' });
    const harness = await renderPanel(current);
    const stop = [...harness.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Stop graph'),
    );
    assert.ok(stop);

    harness.setCurrentWithoutNotification(snapshot({ graphId: 'graph-2', status: 'active' }));
    await act(async () => {
      (stop as HTMLElement).click();
      await Promise.resolve();
    });

    assert.deepEqual(harness.stopCalls, [
      { sessionId: 'session-1', expectedGraphId: 'graph-1' },
    ]);
    assert.match(harness.container.textContent ?? '', /Could not stop the graph/);
    await act(async () => harness.root.unmount());
  });

  it('does not leak a deferred stop result across a root session switch', async () => {
    const sessionA = snapshot({
      rootSessionId: 'session-a',
      graphId: 'graph-a',
      status: 'active',
    });
    const sessionB = snapshot({
      rootSessionId: 'session-b',
      graphId: 'graph-b',
      status: 'active',
    });
    const harness = installGraphRenderer(sessionA, [sessionB]);
    await harness.renderSession(sessionA.rootSessionId);
    const stopA = [...harness.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Stop graph'),
    );
    assert.ok(stopA);
    const stopRead = harness.holdNextStop(sessionA.rootSessionId);
    await act(async () => {
      (stopA as HTMLElement).click();
      await stopRead.started;
    });

    await harness.renderSession(sessionB.rootSessionId);
    assert.match(harness.container.textContent ?? '', /Stop graph/);
    assert.doesNotMatch(harness.container.textContent ?? '', /Could not stop the graph/);

    await act(async () => {
      stopRead.release();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent ?? '', /Stop graph/);
    assert.doesNotMatch(harness.container.textContent ?? '', /Could not stop the graph/);
    await act(async () => harness.root.unmount());
  });

  it('does not leak a deferred stop result across an epoch rollover', async () => {
    const graphA = snapshot({ graphId: 'graph-a', status: 'active' });
    const harness = await renderPanel(graphA);
    const stopA = [...harness.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Stop graph'),
    );
    assert.ok(stopA);
    const stopRead = harness.holdNextStop(graphA.rootSessionId);
    await act(async () => {
      (stopA as HTMLElement).click();
      await stopRead.started;
    });

    await harness.setSnapshot(snapshot({ graphId: 'graph-b', status: 'active' }));
    assert.match(harness.container.textContent ?? '', /Stop graph/);
    assert.doesNotMatch(harness.container.textContent ?? '', /Stopping/);
    assert.doesNotMatch(harness.container.textContent ?? '', /Could not stop the graph/);

    await act(async () => {
      stopRead.release();
      await Promise.resolve();
    });
    assert.match(harness.container.textContent ?? '', /Stop graph/);
    assert.doesNotMatch(harness.container.textContent ?? '', /Could not stop the graph/);
    await act(async () => harness.root.unmount());
  });

  it('does not leak a deferred current stop result into graph history', async () => {
    const current = snapshot({ graphId: 'graph-2', status: 'active' });
    const history = snapshot({ graphId: 'graph-1', status: 'completed' });
    const harness = installGraphRenderer(current, [history]);
    await harness.renderSession(current.rootSessionId);
    const stop = [...harness.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Stop graph'),
    );
    assert.ok(stop);
    const stopRead = harness.holdNextStop(current.rootSessionId);
    await act(async () => {
      (stop as HTMLElement).click();
      await stopRead.started;
    });

    const selector = harness.container.querySelector('[role="combobox"]');
    assert.ok(selector);
    await act(async () => {
      (selector as HTMLElement).click();
      await Promise.resolve();
    });
    const historyOption = [...document.querySelectorAll('[role="option"]')].find((option) =>
      option.textContent?.includes('History'),
    );
    assert.ok(historyOption);
    await act(async () => {
      (historyOption as HTMLElement).click();
      await Promise.resolve();
    });
    assert.doesNotMatch(harness.container.textContent ?? '', /Stopping/);
    assert.doesNotMatch(harness.container.textContent ?? '', /Could not stop the graph/);

    await act(async () => {
      stopRead.release();
      await Promise.resolve();
    });
    assert.doesNotMatch(harness.container.textContent ?? '', /Could not stop the graph/);
    await act(async () => harness.root.unmount());
  });

  it('reuses cached history during activity and reloads it only after epoch rollover', async () => {
    const graph1 = snapshot({ graphId: 'graph-1', status: 'active' });
    const harness = await renderPanel(graph1);
    assert.deepEqual(harness.epochReadCounts(), { full: 1, current: 0 });

    await harness.setSnapshot({ ...graph1, status: 'waiting', scheduleRevision: 2 });
    await harness.setSnapshot({ ...graph1, status: 'active', scheduleRevision: 3 });
    assert.deepEqual(harness.epochReadCounts(), { full: 1, current: 2 });

    await harness.setSnapshot(snapshot({ graphId: 'graph-2', status: 'active' }));
    assert.deepEqual(harness.epochReadCounts(), { full: 2, current: 3 });
    await act(async () => harness.root.unmount());
  });

  it('keeps current controls mounted during a background refresh', async () => {
    const graph = snapshot({ graphId: 'graph-1', status: 'active' });
    const harness = await renderPanel(graph);
    const read = harness.holdNextSnapshot(graph.graphId);

    harness.setCurrentWithoutNotification({ ...graph, scheduleRevision: 2 });
    harness.notify();
    await read.started;
    assert.match(harness.container.textContent ?? '', /Stop graph/);

    await act(async () => {
      read.release();
      await Promise.resolve();
    });
    await act(async () => harness.root.unmount());
  });

  it('resumes following the current epoch after the selected history expires', async () => {
    const current = snapshot({ graphId: 'graph-2', status: 'active' });
    const previous = snapshot({ graphId: 'graph-1', status: 'completed' });
    const harness = installGraphRenderer(current, [previous]);
    await act(async () => {
      harness.root.render(
        createElement(AgentGraphPanel, {
          rootSessionId: 'session-1',
          enabled: true,
          locale: 'en',
          onOpenSession: () => undefined,
        }),
      );
      await Promise.resolve();
    });

    const selector = harness.container.querySelector('[role="combobox"]');
    assert.ok(selector);
    await act(async () => {
      (selector as HTMLElement).click();
      await Promise.resolve();
    });
    const historyOption = [...document.querySelectorAll('[role="option"]')].find((option) =>
      option.textContent?.includes('History'),
    );
    assert.ok(historyOption);
    await act(async () => {
      (historyOption as HTMLElement).click();
      await Promise.resolve();
    });
    const combobox = () => harness.container.querySelector('[role="combobox"]')?.textContent ?? '';
    assert.match(combobox(), /#1 · History \(read-only\)/);

    // The selected epoch leaves the bounded directory while the graph rolls over.
    harness.evict('graph-1');
    await harness.setSnapshot(snapshot({ graphId: 'graph-3', status: 'active' }));
    assert.match(combobox(), /#2 · Current/);

    // Follow restored: the next rollover refreshes the panel instead of
    // staying pinned on the fallback graph.
    await harness.setSnapshot(snapshot({ graphId: 'graph-4', status: 'waiting' }));
    assert.match(combobox(), /#3 · Current/);
    await act(async () => harness.root.unmount());
  });

  it('shows dismiss only after the graph has settled', async () => {
    const active = await renderPanel(snapshot({ graphId: 'graph-1', status: 'active' }));
    assert.ok(active.container.querySelector('.maka-agent-graph-panel'));
    assert.equal(active.container.querySelector('.maka-agent-graph-dismiss'), null);
    await act(async () => active.root.unmount());

    const completed = await renderPanel(snapshot({ graphId: 'graph-1', status: 'completed' }));
    assert.ok(completed.container.querySelector('.maka-agent-graph-dismiss'));
    await act(async () => completed.root.unmount());
  });

  it('hides the panel after dismiss and brings it back for a new graph', async () => {
    const harness = await renderPanel(snapshot({ graphId: 'graph-1', status: 'completed' }));
    const dismiss = harness.container.querySelector('.maka-agent-graph-dismiss');
    assert.ok(dismiss);
    await act(async () => {
      (dismiss as HTMLElement).click();
    });
    assert.equal(harness.container.querySelector('.maka-agent-graph-panel'), null);

    await harness.setSnapshot(snapshot({ graphId: 'graph-2', status: 'active' }));
    assert.ok(harness.container.querySelector('.maka-agent-graph-panel'));
    assert.equal(harness.container.querySelector('.maka-agent-graph-dismiss'), null);
    await act(async () => harness.root.unmount());
  });

  it('lets the user dismiss a stopped or failed graph', async () => {
    for (const status of ['stopped', 'failed'] as const) {
      const harness = await renderPanel(snapshot({ graphId: `graph-${status}`, status }));
      const dismiss = harness.container.querySelector('.maka-agent-graph-dismiss');
      assert.ok(dismiss, status);
      await act(async () => {
        (dismiss as HTMLElement).click();
      });
      assert.equal(harness.container.querySelector('.maka-agent-graph-panel'), null, status);
      await act(async () => harness.root.unmount());
    }
  });

  it('keeps session A dismissed after switching A → B → A', async () => {
    const sessionA = snapshot({
      rootSessionId: 'session-a',
      graphId: 'graph-a',
      status: 'completed',
    });
    const sessionB = snapshot({
      rootSessionId: 'session-b',
      graphId: 'graph-b',
      status: 'completed',
    });
    const harness = installGraphRenderer(sessionA);
    await harness.setSnapshot(sessionB);
    await harness.renderSession('session-a');
    const dismiss = harness.container.querySelector('.maka-agent-graph-dismiss');
    assert.ok(dismiss);
    await act(async () => {
      (dismiss as HTMLElement).click();
    });
    assert.equal(harness.container.querySelector('.maka-agent-graph-panel'), null);

    await harness.renderSession('session-b');
    assert.ok(harness.container.querySelector('.maka-agent-graph-panel'));

    await harness.renderSession('session-a');
    assert.equal(harness.container.querySelector('.maka-agent-graph-panel'), null);
    await act(async () => harness.root.unmount());
  });
});
