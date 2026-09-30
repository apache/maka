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
import type { AgentGraphClientSnapshot } from '@maka/runtime/stream-graph-read-model';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AgentGraphPanel } from '../../renderer/agent-graph-panel.js';

type Snapshot = AgentGraphClientSnapshot;
type Listener = () => void;

const savedGlobals = {
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

afterEach(() => Object.assign(globalThis, savedGlobals));

function graph(
  graphId: string,
  status: Snapshot['status'],
  rootSessionId = 'session-a',
): Snapshot {
  return {
    schemaVersion: 1,
    rootSessionId,
    graphId,
    orchestrationMode: 'graph',
    snapshotVersion: '1',
    scheduleRevision: 1,
    topologyFingerprint: `topology:${graphId}`,
    closed: status === 'completed',
    status,
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
  };
}

function operator(
  overrides: Pick<Snapshot['operators'][number], 'operatorId' | 'status'> &
    Partial<Snapshot['operators'][number]>,
): Snapshot['operators'][number] {
  return {
    childSessionId: `child-${overrides.operatorId}`,
    provisionId: `provision-${overrides.operatorId}`,
    agentId: 'reviewer',
    provisionedAt: 1,
    inboundEdgeIds: [],
    outboundEdgeIds: [],
    scheduledWorkIds: [],
    readiness: [],
    omitted: {
      inboundEdgeIds: 0,
      outboundEdgeIds: 0,
      scheduledWorkIds: 0,
      readiness: 0,
      readinessWaits: 0,
    },
    ...overrides,
  };
}

class GraphPanelFixture {
  readonly container: Element;
  readonly root: Root;
  readonly stopCalls: Array<{ sessionId: string; graphId: string }> = [];
  readonly #snapshots = new Map<string, Snapshot>();
  readonly #current = new Map<string, string>();
  readonly #listeners = new Set<Listener>();
  #readsFail = false;

  constructor(...snapshots: Snapshot[]) {
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
    for (const snapshot of snapshots) this.seed(snapshot, !this.#current.has(snapshot.rootSessionId));
    (window as unknown as { maka: unknown }).maka = { graphs: this.#graphApi() };
    const container = document.querySelector('#root');
    assert.ok(container);
    this.container = container;
    this.root = createRoot(container);
  }

  seed(snapshot: Snapshot, current = true): void {
    this.#snapshots.set(snapshot.graphId, snapshot);
    if (current) this.#current.set(snapshot.rootSessionId, snapshot.graphId);
  }

  failReads(value: boolean): void {
    this.#readsFail = value;
  }

  async render(
    sessionId = 'session-a',
    enabled = true,
    onOpenSession: (sessionId: string) => void = () => undefined,
  ): Promise<void> {
    await act(async () => {
      this.root.render(
        createElement(AgentGraphPanel, {
          rootSessionId: sessionId,
          enabled,
          locale: 'en',
          onOpenSession,
        }),
      );
      await Promise.resolve();
    });
  }

  async publish(snapshot: Snapshot): Promise<void> {
    this.seed(snapshot);
    await act(async () => {
      for (const listener of this.#listeners) listener();
      await Promise.resolve();
    });
  }

  async click(selector: string): Promise<void> {
    const target = this.container.querySelector(selector);
    assert.ok(target, selector);
    await act(async () => {
      (target as HTMLElement).click();
      await Promise.resolve();
    });
  }

  async chooseHistory(): Promise<void> {
    await this.click('[role="combobox"]');
    const option = [...document.querySelectorAll('[role="option"]')].find((candidate) =>
      candidate.textContent?.includes('History'),
    );
    assert.ok(option);
    await act(async () => {
      (option as HTMLElement).click();
      await Promise.resolve();
    });
  }

  async close(): Promise<void> {
    await act(async () => this.root.unmount());
  }

  #graphApi() {
    const directory = (sessionId: string) => {
      if (this.#readsFail) throw new Error('Runtime Host unavailable');
      const current = this.#current.get(sessionId);
      const entries = [...this.#snapshots.values()].filter(
        (snapshot) => snapshot.rootSessionId === sessionId,
      );
      return {
        epochs: entries.map((snapshot, index) => ({
          epoch: entries.length - index,
          graphId: snapshot.graphId,
          createdAt: entries.length - index,
          current: snapshot.graphId === current,
        })),
        truncated: false,
      };
    };
    return {
      listEpochs: async (sessionId: string) => directory(sessionId),
      listCurrentEpochs: async (sessionId: string) => directory(sessionId),
      getSnapshot: async (sessionId: string, options?: { graphId?: string }) => {
        if (this.#readsFail) throw new Error('Runtime Host unavailable');
        const graphId = options?.graphId ?? this.#current.get(sessionId);
        const snapshot = graphId ? this.#snapshots.get(graphId) : undefined;
        if (!snapshot || snapshot.rootSessionId !== sessionId) throw new Error('missing graph');
        return snapshot;
      },
      inspectOperator: async () => assert.fail('panel must not inspect an operator while loading'),
      subscribe: (_sessionId: string, listener: Listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
      stop: async (sessionId: string, expectedGraphId: string) => {
        this.stopCalls.push({ sessionId, graphId: expectedGraphId });
        if (this.#current.get(sessionId) !== expectedGraphId) throw new Error('graph changed');
      },
    };
  }
}

describe('AgentGraphPanel boundary contract', () => {
  it('keeps an ordinary inactive session hidden and reveals later graph activity', async () => {
    const fixture = new GraphPanelFixture({
      ...graph('graph-a', 'empty'),
      scheduleRevision: 0,
    });
    await fixture.render('session-a', false);
    assert.equal(fixture.container.textContent, '');

    await fixture.publish(graph('graph-a', 'active'));
    assert.match(fixture.container.textContent ?? '', /Agent Graph/);
    await fixture.close();
  });

  it('surfaces read failure only when the panel has a reason to exist', async () => {
    for (const enabled of [false, true]) {
      const fixture = new GraphPanelFixture(graph('graph-a', 'empty'));
      fixture.failReads(true);
      await fixture.render('session-a', enabled);
      assert.equal(
        /Could not refresh graph state/.test(fixture.container.textContent ?? ''),
        enabled,
      );
      await fixture.close();
    }
  });

  it('renders bounded live and completed output facts without replacing child navigation', async () => {
    const opened: string[] = [];
    const fixture = new GraphPanelFixture({
      ...graph('graph-output', 'active'),
      operators: [
        operator({
          operatorId: 'operator-live',
          status: 'running',
          output: {
            activationId: 'run-live',
            preview: 'Inspecting the renderer projection',
            previewTruncated: true,
            phase: 'streaming',
            previewUpdatedAt: 2_000,
            sourceEventId: 'event-live',
            messageId: 'message-live',
            sampleStartedAt: 1_000,
            outputTokens: 21,
            sampleDurationMs: 1_000,
            tokensPerSecond: 21,
          },
        }),
        operator({
          operatorId: 'operator-done',
          status: 'completed',
          output: {
            activationId: 'run-done',
            preview: 'Projection verified',
            previewTruncated: false,
            phase: 'completed',
            previewUpdatedAt: 3_000,
            sourceEventId: 'event-done',
            sampleStartedAt: 2_000,
          },
        }),
      ],
    });
    await fixture.render('session-a', true, (sessionId) => opened.push(sessionId));

    assert.match(fixture.container.textContent ?? '', /Live output · avg 21\.0 output token\/s/);
    assert.match(fixture.container.textContent ?? '', /…Inspecting the renderer projection/);
    assert.match(fixture.container.textContent ?? '', /Result preview/);
    const open = [...fixture.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Open child task'),
    );
    assert.ok(open);
    await act(async () => (open as HTMLElement).click());
    assert.deepEqual(opened, ['child-operator-live']);
    await fixture.close();
  });

  it('renders history read-only while the current epoch retains stop authority', async () => {
    const current = graph('graph-b', 'active');
    const history = graph('graph-a', 'completed');
    const fixture = new GraphPanelFixture(current, history);
    await fixture.render();
    assert.match(fixture.container.textContent ?? '', /Stop graph/);

    await fixture.chooseHistory();
    assert.match(fixture.container.textContent ?? '', /History \(read-only\)/);
    assert.doesNotMatch(fixture.container.textContent ?? '', /Stop graph/);
    assert.equal(fixture.container.querySelector('.maka-agent-graph-dismiss'), null);
    await fixture.close();
  });

  it('binds stop to the graph that supplied the rendered control', async () => {
    const fixture = new GraphPanelFixture(graph('graph-a', 'active'));
    await fixture.render();
    fixture.seed(graph('graph-b', 'active'));
    const stop = [...fixture.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Stop graph'),
    );
    assert.ok(stop);
    await act(async () => {
      (stop as HTMLElement).click();
      await Promise.resolve();
    });
    assert.deepEqual(fixture.stopCalls, [{ sessionId: 'session-a', graphId: 'graph-a' }]);
    assert.match(fixture.container.textContent ?? '', /Could not stop the graph/);
    await fixture.close();
  });

  it('dismisses only the settled graph identity and returns on rollover', async () => {
    const fixture = new GraphPanelFixture(graph('graph-a', 'completed'));
    await fixture.render();
    await fixture.click('.maka-agent-graph-dismiss');
    assert.equal(fixture.container.querySelector('.maka-agent-graph-panel'), null);

    await fixture.publish(graph('graph-b', 'active'));
    assert.ok(fixture.container.querySelector('.maka-agent-graph-panel'));
    assert.equal(fixture.container.querySelector('.maka-agent-graph-dismiss'), null);
    await fixture.close();
  });

  it('initializes completed graphs collapsed without overriding a manual expansion', async () => {
    const fixture = new GraphPanelFixture(graph('graph-a', 'completed'));
    await fixture.render();
    const panel = () => fixture.container.querySelector('.maka-agent-graph-panel');
    assert.equal(panel()?.getAttribute('data-collapsed'), 'true');
    await fixture.click('.maka-agent-graph-collapse-toggle');
    await fixture.publish({ ...graph('graph-a', 'completed'), scheduleRevision: 2 });
    assert.equal(panel()?.getAttribute('data-collapsed'), 'false');
    await fixture.close();
  });
});
