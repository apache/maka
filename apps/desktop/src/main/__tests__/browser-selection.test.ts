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

import { deferred } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBrowserSelectionCoordinator } from '../../preload/browser-selection.js';
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('browser selection ordering', () => {
  it('does not let a delayed selection resolution undo a newer hide', async () => {
    const pending = deferred<{ scope: string; sessionId: string }>();
    const events: string[] = [];
    const selection = createBrowserSelectionCoordinator(() => pending.promise, {
      capturePage: async () => undefined,
      show: (_documentId, generation, session) => events.push(`show:${generation}:${session.sessionId}`),
      hide: (_documentId, generation) => events.push(`hide:${generation}`),
      setViewport: () => undefined,
    }, 'document-a');

    selection.setActiveSession('desktop-a');
    selection.setActiveSession(null);
    pending.resolve({ scope: 'host-a', sessionId: 'runtime-a' });
    await flush();

    assert.deepEqual(events, ['hide:1', 'hide:3']);
  });

  it('binds capture and viewport delivery to the newest resolved selection generation', async () => {
    const sessions = new Map([
      ['desktop-a', deferred<{ scope: string; sessionId: string }>()],
      ['desktop-b', deferred<{ scope: string; sessionId: string }>()],
    ]);
    const events: string[] = [];
    const selection = createBrowserSelectionCoordinator(
      (sessionId) => sessions.get(sessionId)?.promise ?? Promise.reject(new Error('missing')),
      {
        capturePage: async (session) => {
          events.push(`capture:${session.sessionId}`);
          return 'backdrop';
        },
        show: (_documentId, generation, session) => events.push(`show:${generation}:${session.sessionId}`),
        hide: (_documentId, generation) => events.push(`hide:${generation}`),
        setViewport: (_documentId, generation, session) =>
          events.push(`viewport:${generation}:${session.sessionId}`),
      },
      'document-a',
    );

    selection.setActiveSession('desktop-a');
    const staleCapture = selection.capturePage('desktop-a');
    selection.setViewport({ sessionId: 'desktop-a', rect: null });
    selection.setActiveSession('desktop-b');
    const currentCapture = selection.capturePage('desktop-b');
    selection.setViewport({ sessionId: 'desktop-b', rect: null });
    sessions.get('desktop-b')?.resolve({ scope: 'host-b', sessionId: 'runtime-b' });
    sessions.get('desktop-a')?.resolve({ scope: 'host-a', sessionId: 'runtime-a' });
    await flush();

    assert.equal(await staleCapture, undefined);
    assert.equal(await currentCapture, 'backdrop');
    assert.deepEqual(events, ['hide:1', 'hide:3', 'show:4:runtime-b', 'capture:runtime-b', 'viewport:4:runtime-b']);
  });
});

it('revokes the previous selection before resolving the replacement and stays revoked on failure', async () => {
  const pending = deferred<{ scope: string; sessionId: string }>();
  let selected: string | undefined;
  const events: number[] = [];
  const coordinator = createBrowserSelectionCoordinator(
    (id) => id === 'a' ? Promise.resolve({ scope: 'host', sessionId: 'a' }) : pending.promise,
    {
      show: (_, generation, session) => { events.push(generation); selected = session.sessionId; },
      hide: (_, generation) => { events.push(generation); selected = undefined; },
      capturePage: async () => undefined,
      setViewport: () => {},
    },
  );
  coordinator.setActiveSession('a');
  await flush();
  assert.equal(selected, 'a');
  coordinator.setActiveSession('b');
  assert.equal(selected, undefined, 'A must lose access while B is unresolved');
  pending.reject(Error('Host unavailable'));
  await flush();
  assert.equal(selected, undefined);
  assert.deepEqual(events, [1, 2, 3, 4]);
});
