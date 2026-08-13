import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentGraphClientSnapshot } from '@maka/runtime/stream-graph-read-model';
import { AgentGraphPanel } from '../../renderer/agent-graph-panel.js';

type GraphListener = () => void;

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

function installGraphRenderer(initial: AgentGraphClientSnapshot): {
  container: Element;
  root: Root;
  setSnapshot(next: AgentGraphClientSnapshot): Promise<void>;
  renderSession(sessionId: string): Promise<void>;
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

  const snapshots = new Map<string, AgentGraphClientSnapshot>([
    [initial.rootSessionId, initial],
  ]);
  const listeners = new Set<GraphListener>();
  (window as unknown as { maka: unknown }).maka = {
    graphs: {
      getSnapshot: async (sessionId: string) => {
        const next = snapshots.get(sessionId);
        if (!next) throw new Error(`missing graph snapshot for ${sessionId}`);
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
      stop: async () => undefined,
    },
  };

  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  return {
    container,
    root,
    async setSnapshot(next) {
      snapshots.set(next.rootSessionId, next);
      await act(async () => {
        for (const listener of [...listeners]) listener();
        await Promise.resolve();
      });
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
