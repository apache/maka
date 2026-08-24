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
  const requestedHosts: unknown[] = [];
  const defaultHost = { profileId: 'profile-default', hostId: 'host-default' };
  (globalThis.window as unknown as { maka: unknown }).maka = {
    runtimeHostProfiles: {
      getDefaultHost: async () => defaultHost,
    },
    connections: {
      getSnapshot: async (_sessionId?: string, host?: unknown) => {
        requestedHosts.push(host);
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

  assert.deepEqual(requestedHosts, [defaultHost]);
  assert.equal(current.defaultConnection, 'default-connection');
});

test('reports connection refresh failures against their owning Host', async () => {
  const { root } = installReactRenderer();
  const sessionId = desktopSessionKey({ hostId: 'host-a', sessionId: 'session-a' });
  const diagnosticTargets: unknown[] = [];
  (globalThis.window as unknown as { maka: unknown }).maka = {
    connections: {
      getSnapshot: async () => {
        throw new Error('session unavailable');
      },
    },
    newTasks: {
      getConnections: async () => {
        throw new Error('profile unavailable');
      },
    },
    runtimeHostProfiles: {
      getDefaultHost: async () => ({ profileId: 'profile-default', hostId: 'host-default' }),
    },
  };

  function Probe(props: { target: Parameters<typeof useShellConnections>[0]['target'] }) {
    useShellConnections({
      toastApi: {
        error: (_title, _description, _details, target) => {
          diagnosticTargets.push(target);
        },
      },
      uiLocale: 'en',
      target: props.target,
    });
    return null;
  }

  await act(async () => {
    root.render(createElement(Probe, { target: { kind: 'session', sessionId } }));
  });
  await act(async () => {
    root.render(createElement(Probe, {
      target: {
        kind: 'new-task',
        host: { profileId: 'profile-b', hostId: 'host-b' },
      },
    }));
  });
  await act(async () => {
    root.render(createElement(Probe, { target: { kind: 'default' } }));
  });

  assert.deepEqual(diagnosticTargets, [
    { sessionId },
    { profileId: 'profile-b' },
    { profileId: 'profile-default' },
  ]);
});

afterEach(() => {
  cleanupFakeDom();
  delete (globalThis as { window?: unknown }).window;
});
