import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { act, createElement, StrictMode } from 'react';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import { useBrowserWorkflowSessionLifecycle } from '../../renderer/use-browser-workflow-session-lifecycle.js';

function Probe(props: { sessionId: string }) {
  useBrowserWorkflowSessionLifecycle(props.sessionId);
  return null;
}

let latestOwnershipCheck: unknown;

function OwnershipProbe(props: { sessionId: string }) {
  latestOwnershipCheck = useBrowserWorkflowSessionLifecycle(props.sessionId);
  return null;
}

describe('browser workflow session lifecycle', () => {
  afterEach(() => {
    cleanupFakeDom();
  });

  it('releases the latest browser workflow session when its panel unmounts', async () => {
    const { root } = installReactRenderer();
    const released: string[] = [];
    (globalThis.window as unknown as { maka: unknown }).maka = {
      browser: {
        workflows: {
          releaseSession: (sessionId: string) => released.push(sessionId),
        },
      },
    };

    await act(async () => {
      root.render(createElement(Probe, { sessionId: 'session-first' }));
    });
    await act(async () => {
      root.render(createElement(Probe, { sessionId: 'session-latest' }));
    });
    await act(async () => {
      root.unmount();
    });

    assert.deepEqual(released, ['session-latest']);
  });

  it('keeps the browser workflow session during a StrictMode effect replay', async () => {
    const { root } = installReactRenderer();
    const released: string[] = [];
    (globalThis.window as unknown as { maka: unknown }).maka = {
      browser: {
        workflows: {
          releaseSession: (sessionId: string) => released.push(sessionId),
        },
      },
    };

    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Probe, { sessionId: 'session-strict' })));
    });

    assert.deepEqual(released, []);

    await act(async () => {
      root.unmount();
    });

    assert.deepEqual(released, ['session-strict']);
  });

  it('rejects an async completion owned by the previous panel session', async () => {
    const { root } = installReactRenderer();
    (globalThis.window as unknown as { maka: unknown }).maka = {
      browser: {
        workflows: {
          releaseSession: () => {},
        },
      },
    };

    await act(async () => {
      root.render(createElement(OwnershipProbe, { sessionId: 'session-first' }));
    });
    assert.equal(typeof latestOwnershipCheck, 'function');
    const firstSessionOwnsCompletion = latestOwnershipCheck as (sessionId: string) => boolean;
    assert.equal(firstSessionOwnsCompletion('session-first'), true);

    await act(async () => {
      root.render(createElement(OwnershipProbe, { sessionId: 'session-latest' }));
    });

    assert.equal(firstSessionOwnsCompletion('session-first'), false);
    assert.equal(firstSessionOwnsCompletion('session-latest'), true);

    await act(async () => {
      root.unmount();
    });
  });
});
