import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement } from 'react';
import type { DesktopConnectionSnapshot } from '../../shared/desktop-connection-snapshot.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';
import { useShellConnections } from '../../renderer/use-shell-connections.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

const EMPTY: DesktopConnectionSnapshot = {
  connections: [],
  defaultConnection: null,
  chatModelChoices: [],
};

function snapshot(defaultConnection: string): DesktopConnectionSnapshot {
  return { ...EMPTY, defaultConnection };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test('keeps connection projections isolated and cached by owning Host', async () => {
  const { root } = installReactRenderer();
  const sessionA = desktopSessionKey({ hostId: 'host-a', sessionId: 'session-a' });
  const sessionB = desktopSessionKey({ hostId: 'host-b', sessionId: 'session-b' });
  const pendingB = deferred<DesktopConnectionSnapshot>();
  const seen: Array<string | null> = [];
  (globalThis.window as unknown as { maka: unknown }).maka = {
    connections: {
      getSnapshot: async (sessionId?: string) => {
        if (sessionId === sessionA) return snapshot('connection-a');
        if (sessionId === sessionB) return pendingB.promise;
        return EMPTY;
      },
    },
  };

  function Probe(props: { sessionId: string }) {
    const connections = useShellConnections({
      toastApi: { error: assert.fail },
      uiLocale: 'en',
      target: { kind: 'session', sessionId: props.sessionId },
    });
    seen.push(connections.snapshot.defaultConnection);
    return null;
  }

  await act(async () => {
    root.render(createElement(Probe, { sessionId: sessionA }));
  });
  assert.equal(seen.at(-1), 'connection-a');

  await act(async () => {
    root.render(createElement(Probe, { sessionId: sessionB }));
  });
  assert.equal(seen.at(-1), null, 'Host B must not display Host A connection state');

  await act(async () => {
    pendingB.resolve(snapshot('connection-b'));
    await pendingB.promise;
  });
  assert.equal(seen.at(-1), 'connection-b');

});

test('loads the default Host projection without waiting for the new-task catalog', async () => {
  const { root } = installReactRenderer();
  const requestedSessions: Array<string | undefined> = [];
  (globalThis.window as unknown as { maka: unknown }).maka = {
    connections: {
      getSnapshot: async (sessionId?: string) => {
        requestedSessions.push(sessionId);
        return snapshot('default-connection');
      },
    },
  };
  let current: DesktopConnectionSnapshot = EMPTY;

  function Probe() {
    current = useShellConnections({
      toastApi: { error: assert.fail },
      uiLocale: 'en',
      target: { kind: 'default' },
    }).snapshot;
    return null;
  }

  await act(async () => {
    root.render(createElement(Probe));
  });

  assert.deepEqual(requestedSessions, [undefined]);
  assert.equal(current.defaultConnection, 'default-connection');
});

afterEach(() => {
  cleanupFakeDom();
  delete (globalThis as { window?: unknown }).window;
});
